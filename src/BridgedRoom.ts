/*
Copyright 2019 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import axios from "axios";
import { Logger, Intent } from "matrix-appservice-bridge";
import {IMatrixReplyEvent, SlackGhost} from "./SlackGhost";
import { Main, METRIC_SENT_MESSAGES } from "./Main";
import { default as substitutions, getFallbackForMissingEmoji, IMatrixToSlackResult } from "./substitutions";
import * as emoji from "node-emoji";
import {ISlackMessageEvent, ISlackEvent, ISlackMessageDeletedEvent} from "./BaseSlackHandler";
import { WebAPIPlatformError, WebClient } from "@slack/web-api";
import { ChatUpdateResponse,
    ChatPostMessageResponse, ConversationsInfoResponse, FilesSharedPublicURLResponse } from "./SlackResponses";
import { RoomEntry, EventEntry, TeamEntry } from "./datastore/Models";
import {FileMessageEventContent, MatrixClient, MessageEventContent} from "matrix-bot-sdk";
import {SlackMessageParser} from "./SlackMessageParser";

const log = new Logger("BridgedRoom");

export type SlackChannelType = "mpim" | "im" | "channel" | "group" | "unknown";

interface IBridgedRoomOpts {
    matrix_room_id: string;
    inbound_id: string;
    slack_channel_name?: string;
    slack_channel_id?: string;
    slack_webhook_uri?: string;
    slack_team_id?: string;
    slack_type: SlackChannelType;
    is_private?: boolean;
    puppet_owner?: string;
}

interface ISlackChatMessagePayload extends IMatrixToSlackResult {
    as_user?: boolean;
    channel?: string;
    thread_ts?: string;
    icon_url?: string;
}

const RECENT_MESSAGE_MAX = 10;
const PUPPET_INCOMING_DELAY_MS = 5000;


/**
 * A BridgedRoom is a 1-to-1 connection of a Matrix room and a Slack channel.
 * It adds, updates and removes ghosts on both sides to represent users from the other side.
 * It also posts as these ghosts.
 */
export class BridgedRoom {
    public get isDirty(): boolean {
        return this.dirty;
    }

    public get InboundId(): string {
        return this.inboundId;
    }

    public set InboundId(value: string) {
        this.setValue("inboundId", value);
    }

    public get SlackChannelId(): string|undefined {
        return this.slackChannelId;
    }

    public set SlackChannelId(value: string|undefined) {
        this.setValue("slackChannelId", value);
    }

    public get SlackChannelName(): string|undefined {
        return this.slackChannelName;
    }

    public set SlackChannelName(value: string|undefined) {
        this.setValue("slackChannelName", value);
    }

    public get SlackWebhookUri(): string|undefined {
        return this.slackWebhookUri;
    }

    public set SlackWebhookUri(value: string|undefined) {
        this.setValue("slackWebhookUri", value);
    }

    public get MatrixRoomId(): string {
        return this.matrixRoomId;
    }

    public get SlackTeamId(): string|undefined {
        return this.slackTeamId;
    }

    public get RemoteATime(): number|undefined {
        return this.slackATime;
    }

    public get MatrixATime(): number|undefined {
        return this.matrixATime;
    }

    public get SlackClient(): WebClient|undefined {
        return this.botClient;
    }

    public get IsPrivate(): boolean|undefined {
        return this.isPrivate;
    }

    public get SlackType(): SlackChannelType {
        return this.slackType;
    }

    public migrateToNewRoomId(newRoomId: string): void {
        this.matrixRoomId = newRoomId;
    }

    public static fromEntry(main: Main, entry: RoomEntry, team?: TeamEntry, botClient?: WebClient): BridgedRoom {
        return new BridgedRoom(main, {
            inbound_id: entry.remote_id,
            matrix_room_id: entry.matrix_id,
            slack_channel_id: entry.remote.id,
            slack_channel_name: entry.remote.name,
            slack_team_id: entry.remote.slack_team_id,
            slack_webhook_uri: entry.remote.webhook_uri,
            puppet_owner: entry.remote.puppet_owner,
            is_private: entry.remote.slack_private,
            slack_type: entry.remote.slack_type as SlackChannelType,
        }, team, botClient);
    }

    private matrixRoomId: string;
    private inboundId: string;
    private slackChannelName?: string;
    private slackChannelId?: string;
    private slackWebhookUri?: string;
    private slackTeamId?: string;
    private slackType: SlackChannelType;
    private isPrivate: boolean;
    private puppetOwner?: string;

    // last activity time in epoch seconds
    private slackATime?: number;
    private matrixATime?: number;
    private intent?: Intent;
    // Is the matrix room in use by the bridge.
    public MatrixRoomActive: boolean;
    private recentSlackMessages: string[] = [];

    private slackSendLock: Promise<unknown> = Promise.resolve();

    private waitingForJoin?: Promise<void>;
    private waitingForJoinResolve?: () => void;

    /**
     * True if this instance has changed from the version last read/written to the RoomStore.
     */
    private dirty: boolean;

    constructor(private main: Main, opts: IBridgedRoomOpts, private team?: TeamEntry, private botClient?: WebClient) {

        this.MatrixRoomActive = true;
        if (!opts.inbound_id) {
            throw Error("BridgedRoom requires an inbound ID");
        }
        if (!opts.matrix_room_id) {
            throw Error("BridgedRoom requires an Matrix Room ID");
        }

        this.matrixRoomId = opts.matrix_room_id;
        this.inboundId = opts.inbound_id;
        this.slackChannelName = opts.slack_channel_name;
        this.slackChannelId = opts.slack_channel_id;
        this.slackWebhookUri = opts.slack_webhook_uri;
        this.slackTeamId = opts.slack_team_id;
        this.slackType = opts.slack_type || "channel";
        if (opts.is_private === undefined) {
            opts.is_private = false;
        }
        this.isPrivate = opts.is_private;
        this.puppetOwner = opts.puppet_owner;
        this.dirty = true;
    }

    public waitForJoin() {
        if (this.main.encryptRoom && (this.SlackType === "im" || this.SlackType === "group")) {
            log.debug(`Will wait for user to join room, since room type is a ${this.SlackType}`);
            // This might be an encrypted message room. Delay sending until at least one matrix user joins.
            this.waitingForJoin = new Promise((resolve) => this.waitingForJoinResolve = resolve);
        }
    }

    public updateUsingChannelInfo(channelInfo: ConversationsInfoResponse): void {
        const chan = channelInfo.channel;
        this.setValue("isPrivate", chan.is_private);
        if (chan.is_channel) {
            this.setValue("slackType", "channel");
        } else if (chan.is_mpim) {
            // note: is_group is also set for mpims, so order is important
            this.setValue("slackType", "mpim");
        } else if (chan.is_group) {
            this.setValue("slackType", "group");
        } else if (chan.is_im) {
            this.setValue("slackType", "im");
        } else {
            this.setValue("slackType", "unknown");
        }
    }

    public getStatus(): string {
        if (!this.slackWebhookUri && !this.botClient) {
            return "pending-params";
        }
        if (!this.slackChannelName) {
            return "pending-name";
        }
        if (!this.botClient) {
            return "ready-no-token";
        }
        return "ready";
    }

    /**
     * Returns data to write to the RoomStore
     * As a side-effect will also clear the isDirty() flag
     */
    public toEntry(): RoomEntry {
        const entry = {
            id: `INTEG-${this.inboundId}`,
            matrix_id: this.matrixRoomId,
            remote: {
                id: this.slackChannelId!,
                name: this.slackChannelName!,
                slack_team_id: this.slackTeamId!,
                slack_type: this.slackType!,
                slack_private: this.isPrivate,
                webhook_uri: this.slackWebhookUri!,
                puppet_owner: this.puppetOwner!,
            },
            remote_id: this.inboundId,
        };
        this.dirty = false;
        return entry;
    }

    public async getClientForRequest(userId: string): Promise<{id: string, client: WebClient}|null> {
        const puppet = await this.main.clientFactory.getClientForUserWithId(this.SlackTeamId!, userId);
        if (puppet) {
            return puppet;
        }
        if (this.botClient) {
            return {
                id: "BOT",
                client: this.botClient,
            };
        }
        return null;
    }

    public async onMatrixReaction(message: any): Promise<void> {
        const relatesTo = message.content["m.relates_to"];
        const eventStore = this.main.datastore;
        const event = await eventStore.getEventByMatrixId(message.room_id, relatesTo.event_id);

        // If we don't get an event then exit
        if (event === null) {
            log.debug("Could not find event to react to.");
            return;
        }

        // Convert the unicode emoji into a slack emote name
        let emojiKeyName: string;
        const emojiItem = emoji.find(relatesTo.key);
        if (emojiItem !== undefined) {
            emojiKeyName = emojiItem.key;
        } else {
            emojiKeyName = relatesTo.key;
            // Strip the colons
            if (emojiKeyName.startsWith(":") && emojiKeyName.endsWith(":")) {
                emojiKeyName = emojiKeyName.slice(1, emojiKeyName.length - 1);
            }
        }
        const clientForRequest = await this.getClientForRequest(message.sender);
        if (!clientForRequest) {
            log.warn("No client to handle reaction");
            return;
        }
        const { client, id } = clientForRequest;
        // We must do this before sending to avoid racing
        // Use the unicode key for uniqueness
        this.addRecentSlackMessage(`reactadd:${relatesTo.key}:${id}:${event.slackTs}`);

        // TODO: This only works once from matrix if we are sending the event as the
        // bot user. Search for #fix_reactions_as_bot.
        const res = await client.reactions.add({
            as_user: false,
            channel: this.slackChannelId,
            name: emojiKeyName,
            timestamp: event.slackTs,
        });

        if (!res.ok) {
            log.error(`HTTP Error from Slack when adding the reaction :${emojiKeyName}: to ${event.slackTs}: `, res.error);
            return;
        }

        log.info(`Reaction :${emojiKeyName}: added to ${event.slackTs}. Matrix room ID: ${message.room_id}. Matrix event ID: ${message.event_id}`);

        await this.main.datastore.upsertReaction({
            roomId: message.room_id,
            eventId: message.event_id,
            slackChannelId: this.slackChannelId!,
            slackMessageTs: event.slackTs,
            // TODO We post reactions as the bot, not the user. Search for #fix_reactions_as_bot.
            slackUserId: this.team!.user_id,
            reaction: emojiKeyName,
        });
    }

    public async onMatrixRedaction(message: any): Promise<void> {
        const clientForRequest = await this.getClientForRequest(message.sender);
        if (!clientForRequest) {
            log.warn("No client to handle redaction");
            return;
        }
        const { client } = clientForRequest;

        const event = await this.main.datastore.getEventByMatrixId(message.room_id, message.redacts);

        // If we don't get an event then exit
        if (event === null) {
            const reactionEntry = await this.main.datastore.getReactionByMatrixId(message.room_id, message.redacts);

            if (reactionEntry) {
                await this.main.datastore.deleteReactionByMatrixId(message.room_id, message.redacts);
                const reactionDescription = `"${reactionEntry.reaction}" on message ${reactionEntry.slackMessageTs} ` +
                    `in channel ${reactionEntry.slackChannelId}`;
                try {
                    await client.reactions.remove({
                        as_user: false,
                        channel: reactionEntry.slackChannelId,
                        timestamp: reactionEntry.slackMessageTs,
                        name: reactionEntry.reaction,
                    });
                    log.info(`Redacted reaction ${reactionDescription}`);
                } catch (error) {
                    log.warn(`Failed redact reaction ${reactionDescription}. Matrix room/event: ${message.room_id}, ${message.redacts}`);
                    log.warn(error);
                    throw error;
                }
                return;
            }

            log.debug(`Could not find event '${message.redacts}' in room '${message.room_id}' to delete.`);
            return;
        }

        // Delete event so it's not over-redacted on Matrix when we receive the "message_deleted" event from Slack.
        // https://github.com/matrix-org/matrix-appservice-slack/issues/430
        await this.main.datastore.deleteEventByMatrixId(message.room_id, message.redacts);

        try {
            // Note: bots can only delete their own messages, ergo it's possible that this may fail :(
            await client.chat.delete({
                as_user: false,
                channel: this.slackChannelId!,
                ts: event.slackTs,
            });
        } catch (ex) {
            log.warn(`Failed to delete ${event.slackTs}`, ex);
        }
    }

    public async onMatrixEdit(message: any): Promise<boolean> {
        const clientForRequest = await this.getClientForRequest(message.sender);
        if (!clientForRequest) {
            log.warn("No client to handle edit");
            return false;
        }
        const { client } = clientForRequest;

        const event = await this.main.datastore.getEventByMatrixId(
            message.room_id,
            message.content["m.relates_to"].event_id,
        );

        if (!event) {
            log.debug("Skipping matrix edit because couldn't find event in datastore");
            return false;
        }
        // re-write the message so the matrixToSlack converter works as expected.
        let newMessage = JSON.parse(JSON.stringify(message));
        newMessage.content = message.content["m.new_content"];
        newMessage = await this.stripMatrixReplyFallback(newMessage);

        const body = await substitutions.matrixToSlack(newMessage, this.main, this.SlackTeamId!);

        if (!body || !body.text) {
            log.warn(`Dropped edit ${message.event_id}, message content could not be identified`);
            // Could not handle content, dropped
            return false;
        }

        const res = (await client.chat.update({
            ts: event.slackTs,
            as_user: false,
            channel: this.slackChannelId!,
            ...body,
            // We include this for type safety as Typescript isn't aware that body.text is defined
            // from the ...body statement.
            text: body.text,
        })) as ChatUpdateResponse;

        this.main.incCounter(METRIC_SENT_MESSAGES, {side: "remote"});
        if (!res.ok) {
            log.error("HTTP Error: ", res.error);
            throw Error("Failed to send");
        }
        // Add this event to the event store
        await this.main.datastore.upsertEvent(
            message.room_id,
            message.event_id,
            this.slackChannelId!,
            res.ts,
        );
        return true;
    }

    public async onMatrixMessage(message: any): Promise<boolean> {
        const puppetedClient = await this.main.clientFactory.getClientForUser(this.SlackTeamId!, message.sender);
        if (!this.slackWebhookUri && !this.botClient && !puppetedClient) { return false; }
        const slackClient = puppetedClient || this.botClient;
        const user = this.main.getOrCreateMatrixUser(message.sender);
        message = await this.stripMatrixReplyFallback(message);
        const matrixToSlackResult = await substitutions.matrixToSlack(message, this.main, this.SlackTeamId!);
        if (!matrixToSlackResult) {
            // Could not handle content, dropped.
            log.warn(`Dropped ${message.event_id}, message content could not be identified`);
            return false;
        }
        if (matrixToSlackResult.encrypted_file) {
            if (!slackClient) {
                // No client
                return false;
            }
            log.debug("Room might be encrypted, uploading file to Slack");
            // Media might be encrypted, upload it to Slack to be safe.
            const response = await axios.get<ArrayBuffer>(matrixToSlackResult.encrypted_file, {
                headers: {
                    Authorization: `Bearer ${slackClient.token}`,
                },
                responseType: "arraybuffer",
            });
            if (response.status !== 200) {
                throw Error('Failed to get file');
            }

            const fileResponse = (await slackClient.files.upload({
                file: Buffer.from(response.data),
                filename: message.content.body,
                channels: this.slackChannelId,
            })) as FilesSharedPublicURLResponse;

            // The only way to dedupe these is to fetch the ts's from the response
            // of this upload.
            if (fileResponse.file.shares) {
                Object.values(fileResponse.file.shares.private || {}).concat(
                    Object.values(fileResponse.file.shares.public || {})
                ).forEach(share =>
                    this.addRecentSlackMessage(share[0].ts)
                );
            }
        }
        const body: ISlackChatMessagePayload = {
            ...matrixToSlackResult,
            as_user: false,
            username: (await user.getDisplaynameForRoom(message.room_id)) || matrixToSlackResult.username,
        };
        const text = body.text;
        if (!body.attachments && !text) {
            // The message type might not be understood. In any case, we can't send something without
            // text.
            log.warn(`Dropped ${message.event_id}, message had no attachments or text`);
            return false;
        }
        const reply = await this.findParentReply(message);
        let parentStoredEvent: EventEntry | null = null;
        if (reply !== message.event_id) {
            parentStoredEvent = await this.main.datastore.getEventByMatrixId(message.room_id, reply);
            // We have a reply
            if (parentStoredEvent) {
                body.thread_ts = parentStoredEvent.slackTs;
            }
        }

        const avatarUrl = await user.getAvatarUrlForRoom(message.room_id);

        if (avatarUrl && avatarUrl.indexOf("mxc://") === 0) {
            body.icon_url = this.main.getUrlForMxc(avatarUrl);
        }

        user.bumpATime();
        this.matrixATime = Date.now() / 1000;
        if (!slackClient) {
            if (!this.slackWebhookUri) {
                throw Error('No slackClient and slackWebhookUri');
            }
            const webhookRes = await axios.post(this.slackWebhookUri, body);
            if (webhookRes.status !== 200) {
                log.error("Failed to send webhook message");
            }
            // Webhooks don't give us any ID, so we can't store this.
            return true;
        }
        if (puppetedClient) {
            body.as_user = true;
            delete body.username;
        }

        const metadata = {
            event_type: "matrix_event",
            event_payload: {
                id: encodeURIComponent(message.event_id),
                room_id: encodeURIComponent(message.room_id),
            },
        };

        let res: ChatPostMessageResponse;
        const chatPostMessageArgs = {
            ...body,
            // Ensure that text is defined, even for attachments.
            text: text || "",
            channel: this.slackChannelId!,
            unfurl_links: true,
            metadata,
        };

        try {
            res = await slackClient.chat.postMessage(chatPostMessageArgs) as ChatPostMessageResponse;
        } catch (ex) {
            const platformError = ex as WebAPIPlatformError;
            if (platformError.data?.error === "not_in_channel") {
                await slackClient.conversations.join({
                    channel: chatPostMessageArgs.channel,
                });
                res = await slackClient.chat.postMessage(chatPostMessageArgs) as ChatPostMessageResponse;
            } else {
                throw ex;
            }
        }

        this.addRecentSlackMessage(res.ts);

        this.main.incCounter(METRIC_SENT_MESSAGES, {side: "remote"});
        // Log activity, but don't await the answer or throw errors
        this.main.datastore.upsertActivityMetrics(user, this).catch((err) => {
            log.error(`Error storing activity metrics`, err);
        });

        if (!res.ok) {
            log.error("HTTP Error: ", res.error);
            throw Error("Failed to send");
        }

        // Add this event to the event store
        await this.main.datastore.upsertEvent(
            message.room_id,
            message.event_id,
            this.slackChannelId!,
            res.ts,
        );

        // If this message is in a slack thread we need to append this message to the end of the thread list.
        if (parentStoredEvent) {
            if (parentStoredEvent._extras.slackThreadMessages === undefined) {
                parentStoredEvent._extras.slackThreadMessages = [];
            }
            parentStoredEvent._extras.slackThreadMessages.push(res.ts);
            await this.main.datastore.upsertEvent(parentStoredEvent);
        }
        return true;
    }

    public async onSlackUserLeft(slackId: string): Promise<void> {
        const ghost = await this.main.ghostStore.get(slackId, undefined, this.slackTeamId);
        await ghost.intent.leave(this.matrixRoomId);
    }

    public async onSlackUserJoin(slackId: string, wasInvitedBy?: string): Promise<void> {
        // There are different flows for this:
        // 1 - Slack user invites slack user
        // 2 - Slack user invites matrix user
        // 3 - Matrix user invites slack user
        // 4 - Matrix user invites matrix user
        // 5 - Slack user has joined
        // 6 - Matrix user has joined

        if (this.team?.user_id === slackId) {
            // We never reflect our own slack bot.
            return;
        }

        const recipientPuppet = await this.main.clientFactory.getClientForSlackUser(this.slackTeamId!, slackId);
        const recipientGhost = await this.main.ghostStore.get(slackId, undefined, this.slackTeamId);

        const senderPuppet = await this.main.clientFactory.getClientForSlackUser(this.slackTeamId!, slackId);
        const senderGhost = await this.main.ghostStore.get(slackId, undefined, this.slackTeamId);
        const mxid = await this.main.datastore.getPuppetMatrixUserBySlackId(this.slackTeamId!, slackId);

        if (!wasInvitedBy) {
            if (!recipientPuppet) {
                log.debug(`S-> ${slackId} joined ${this.SlackChannelId}`);
                // 5
                await recipientGhost.intent.join(this.matrixRoomId);
            } else if (mxid) {
                log.debug(`M-> ${slackId} joined ${this.SlackChannelId}`);
                // 6
                await this.main.botIntent.invite(this.matrixRoomId, mxid);
            }
            return;
        }

        if (!recipientPuppet && !senderPuppet) {
            log.debug(`S->S ${slackId} was invited by ${wasInvitedBy}`);
            // 1
            await senderGhost.intent.invite(this.matrixRoomId, recipientGhost.matrixUserId);
            await recipientGhost.intent.join(this.matrixRoomId);
        } else if (recipientPuppet && mxid) {
            // 2 & 4
            log.debug(`S|M->M${mxid} was invited by ${wasInvitedBy}`);
            await senderGhost.intent.invite(this.matrixRoomId, mxid);
        } else if (senderPuppet && !recipientPuppet) {
            log.debug(`M->S ${slackId} was invited by ${wasInvitedBy}`);
            // 3
            await recipientGhost.intent.join(this.matrixRoomId);
            // No-op
        }
    }

    public async onMatrixLeave(userId: string): Promise<void> {
        log.info(`Leaving ${userId} from ${this.SlackChannelId}`);
        const slackTeamId = this.SlackTeamId!;
        const puppetedClient = await this.main.clientFactory.getClientForUser(slackTeamId, userId);
        if (!puppetedClient) {
            log.debug("No client");
            return;
        }
        if (this.SlackType === "im") {
            await this.main.actionUnlink({ matrix_room_id: this.MatrixRoomId });
        } else {
            await puppetedClient.conversations.leave({ channel: slackTeamId });
        }
    }

    public async onMatrixJoin(userId: string): Promise<void> {
        log.info(`${userId} joined ${this.MatrixRoomId} (${this.SlackChannelId})`);
        if (this.waitingForJoinResolve) {
            this.waitingForJoinResolve();
        }
        const puppetedClient = await this.main.clientFactory.getClientForUser(this.SlackTeamId!, userId);
        if (!puppetedClient) {
            log.debug("No client");
            return;
        }
        if (this.SlackType !== "im") {
            log.info(`Joining ${userId} to ${this.SlackChannelId}`);
            // DMs don't need joining
            await puppetedClient.conversations.join({ channel: this.SlackChannelId! });
        }
    }

    public async onMatrixInvite(inviter: string, invitee: string): Promise<void> {
        const puppetedClient = await this.main.clientFactory.getClientForUser(this.SlackTeamId!, inviter);
        if (!puppetedClient) {
            log.debug("No client");
            return;
        }
        const ghost = await this.main.ghostStore.get(invitee);
        if (!ghost) {
            log.debug("No ghost");
            return;
        }
        await puppetedClient.conversations.invite({channel: this.slackChannelId!, users: ghost.slackId });
    }

    public async onSlackMessage(message: ISlackMessageEvent): Promise<void> {
        if (this.waitingForJoin) {
            log.debug("Waiting for user to join before sending DM message");
            // Encrypted rooms shouldn't send DM messages until the user has joined.
            await this.waitingForJoin;
            this.waitingForJoin = undefined;
        }
        if (this.slackTeamId && message.user) {
            // This just checks if the user *could* be puppeted. If they are, delay handling their incoming messages.
            const hasPuppet = null !== await this.main.datastore.getPuppetTokenBySlackId(this.slackTeamId, message.user);
            if (hasPuppet) {
                await new Promise((r) => setTimeout(r, PUPPET_INCOMING_DELAY_MS));
            }
        }
        const isMessageChangedEvent = message.subtype && message.subtype === 'message_changed';
        if (!isMessageChangedEvent && this.recentSlackMessages.includes(message.ts)) {
            // We sent this, ignore.
            return;
        }
        try {
            const ghost = await this.main.ghostStore.getForSlackMessage(message, this.slackTeamId);
            await ghost.cancelTyping(this.MatrixRoomId); // If they were typing, stop them from doing that.

            let isTeamSyncEnabledForUsers = false;
            for (const team in this.main.config.team_sync) {
                if (team === "all" || team === this.slackTeamId ) {
                    if (this.main.config.team_sync[team].users?.enabled) {
                        isTeamSyncEnabledForUsers = true;
                    }
                }
            }
            if (!isTeamSyncEnabledForUsers) {
                const ghostChanged = await ghost.update(message, this.SlackClient);
                if (ghostChanged) {
                    await this.main.fixDMMetadata(this, ghost);
                }
            }

            this.slackSendLock = this.slackSendLock.then(() => {
                // Check again
                if (!isMessageChangedEvent && this.recentSlackMessages.includes(message.ts)) {
                    // We sent this, ignore
                    return;
                }
                if (!this.SlackClient) {
                    throw Error("slackClient is required to handle a slack message");
                }
                return this.handleSlackMessage(message, ghost, this.SlackClient).catch((ex) => {
                    log.warn(`Failed to handle slack message ${message.ts} for ${this.MatrixRoomId} ${this.slackChannelId}`, ex);
                });
            });
            await this.slackSendLock;
        } catch (err) {
            log.error("Failed to process event");
            log.error(err);
        }
    }

    public async onSlackMessageDeleted(message: ISlackMessageDeletedEvent): Promise<void> {
        const originalEvent = await this.main.datastore.getEventBySlackId(message.channel, message.deleted_ts);
        if (!originalEvent) {
            throw Error("Could not find original event for deleted message");
        }

        let client: MatrixClient | undefined;

        const originalMessage = message.previous_message;
        if (originalMessage?.user) {
            const originalGhost = await this.main.ghostStore.get(originalMessage.user, undefined, this.slackTeamId);
            if (originalGhost) {
                client = originalGhost.intent.matrixClient;
            }
        }

        if (!client) {
            log.warn("Ghost for deleted message was not found. Will attempt to redact through the bot.");
            client = this.main.botIntent.matrixClient;
        }

        await client.redactEvent(originalEvent.roomId, originalEvent.eventId);
    }

    public async onSlackReactionAdded(
        message: {
            event_ts: string,
            item: {
                channel: string,
                ts: string,
            },
            reaction: string,
            user_id: string,
        },
        teamId: string,
    ): Promise<void> {
        if (message.user_id === this.team!.user_id) {
            return;
        }

        let reactionKey = emoji.emojify(`:${message.reaction}:`, getFallbackForMissingEmoji);
        // Element uses the default thumbsup and thumbsdown reactions with an appended variant character.
        if (reactionKey === '👍' || reactionKey === '👎') {
            reactionKey += '\ufe0f'.normalize(); // VARIATION SELECTOR-16
        }

        if (this.recentSlackMessages.includes(`reactadd:${reactionKey}:${message.user_id}:${message.item.ts}`)) {
            // We sent this, ignore.
            return;
        }
        const ghost = await this.main.ghostStore.getForSlackMessage(message, teamId);
        if (await ghost.update(message, this.SlackClient)) {
            await this.main.fixDMMetadata(this, ghost);
        }

        const event = await this.main.datastore.getEventBySlackId(message.item.channel, message.item.ts);

        if (event === null) {
            return;
        }
        let response: { event_id: string };
        const reactionDesc = `${reactionKey} for ${event.eventId} as ${ghost.matrixUserId}. Matrix room/event: ${this.MatrixRoomId}`;
        try {
            response = await ghost.sendReaction(
                this.MatrixRoomId,
                event.eventId,
                reactionKey,
                message.item.channel,
                message.event_ts
            );
            log.info(`Sending reaction ${reactionDesc}`);
        } catch (error) {
            log.warn(`Failed to send reaction ${reactionDesc}`);
            throw error;
        }
        await this.main.datastore.upsertReaction({
            roomId: this.MatrixRoomId,
            eventId: response.event_id,
            slackChannelId: message.item.channel,
            slackMessageTs: message.item.ts,
            slackUserId: message.user_id,
            reaction: message.reaction,
        });
    }

    public async onSlackReactionRemoved(
        msg: {
            item: {
                channel: string,
                ts: string,
            },
            reaction: string,
            user_id: string,
        },
    ): Promise<void> {
        if (!this.team || msg.user_id === this.team.user_id) {
            return;
        }
        const originalEvent = await this.main.datastore.getReactionBySlackId(msg.item.channel, msg.item.ts, msg.user_id, msg.reaction );
        if (!originalEvent) {
            throw Error('unknown_reaction');
        }
        const botClient = this.main.botIntent.matrixClient;
        await botClient.redactEvent(originalEvent.roomId, originalEvent.eventId);
        await this.main.datastore.deleteReactionBySlackId(msg.item.channel, msg.item.ts, msg.user_id, msg.reaction);
    }

    public async onSlackTyping(event: ISlackEvent, teamId: string): Promise<void> {
        const puppet = await this.main.datastore.getPuppetTokenBySlackId(teamId, event.user_id);
        if (puppet) {
            // Could be us, don't show typing
            return;
        }
        const ghost = await this.main.ghostStore.getForSlackMessage(event, teamId);
        await ghost.sendTyping(this.MatrixRoomId);
    }

    public async leaveGhosts(ghosts: string[]): Promise<void> {
        const promises: Promise<void>[] = [];
        for (const ghost of ghosts) {
            promises.push(this.main.getIntent(ghost).leave(this.matrixRoomId));
        }
        await Promise.all(promises);
    }

    public setBotClient(slackClient: WebClient): void {
        this.botClient = slackClient;
    }

    private setValue<T>(key: string, value: T) {
        const sneakyThis = this as any;
        if (sneakyThis[key] === value) {
            return;
        }
        sneakyThis[key] = value;
        this.dirty = true;
    }

    private async handleSlackMessage(message: ISlackMessageEvent, ghost: SlackGhost, botSlackClient: WebClient) {
        if (!this.SlackTeamId) {
            throw Error("SlackTeamId must be set");
        }
        if (!this.SlackChannelId) {
            throw Error("SlackChannelId must be set");
        }
        if (this.isPrivate === undefined) {
            throw Error("isPrivate must be set");
        }

        const eventTS = message.event_ts || message.ts;

        // Dedupe across RTM/Event streams
        this.addRecentSlackMessage(message.ts);

        if (this.SlackType === "im") {
            const intent = await this.getIntentForRoom();
            if (intent.userId !== ghost.intent.userId &&
                !(await intent.matrixClient.getRoomMembers(this.matrixRoomId, undefined, ["invite", "join"]))
                    .map(m => m.membershipFor).includes(ghost.intent.userId))
            {
                await intent.invite(this.MatrixRoomId, ghost.matrixUserId);
                await ghost.intent.join(this.MatrixRoomId);
            }
        }

        ghost.bumpATime();
        this.slackATime = Date.now() / 1000;
        const subtype = message.subtype;

        // Log activity, but don't await the answer or throw errors
        this.main.datastore.upsertActivityMetrics(ghost, this).catch((err) => {
            log.error(`Error storing activity metrics`, err);
        });

        // Private rooms don't send the usual join events, so we listen for these here.
        if (subtype === "group_join" && message.user) {
            return this.onSlackUserJoin(message.user, message.inviter);
        }

        let lastEventInThread: IMatrixReplyEvent | null = null;
        if (message.thread_ts) {
            lastEventInThread = await this.getReplyEvent(this.MatrixRoomId, message, this.SlackChannelId);
            if (lastEventInThread) {
                lastEventInThread = await this.stripMatrixReplyFallback(lastEventInThread);
            } else {
                log.warn("Could not find matrix event for parent reply", message.thread_ts);
            }
        }

        const parser = new SlackMessageParser(
            this.main.botIntent,
            this.main.datastore,
            this.main.rooms,
            this.main.ghostStore,
            this.main.bridgeMatrixBot,
            this.matrixRoomId,
            botSlackClient,
            this.SlackTeamId,
            this.SlackType,
            this.isPrivate,
            this.main.clientFactory,
            this.main.config.homeserver.max_upload_size,
            this.main
        );
        const matrixEvents = await parser.parse(message);
        if (matrixEvents.length === 0) {
            log.warn(`Ignoring message with subtype: ${subtype}`);
            return;
        }

        // Upload files and replace URLs in matrix events.
        const eventsToPublish: MessageEventContent[] = [];
        for (const event of matrixEvents) {
            if (!["m.image", "m.video", "m.audio", "m.file"].includes(event.msgtype)) {
                // Not a file, nothing to upload.
                eventsToPublish.push(event);
                continue;
            }

            const uploadedEvent = await this.uploadFileAndThumbnail(event as FileMessageEventContent, ghost);
            if (uploadedEvent) {
                eventsToPublish.push(uploadedEvent);
            }
        }

        for (const event of eventsToPublish) {
            // Edits should not be sent to thread, as sendInThread is only for new events, not edits.
            // Edits still work correctly in threads nonetheless.
            const isEdit = event["m.new_content"];
            if (lastEventInThread && !isEdit) {
                await ghost.sendInThread(this.MatrixRoomId, event, this.SlackChannelId, eventTS, lastEventInThread);
                return;
            }

            const record = event as unknown as Record<string, string>;
            await ghost.sendMessage(this.MatrixRoomId, record, this.SlackChannelId, eventTS);
        }
    }

    private async uploadFileAndThumbnail(event: FileMessageEventContent, ghost: SlackGhost): Promise<FileMessageEventContent | null> {
        const upload = async (url: string, mimetype: string | undefined, title: string): Promise<string | null> => {
            mimetype = mimetype ?? "";
            const matrixUrl = await ghost.uploadContentFromUrlWithToken({mimetype, title}, url);
            if (!matrixUrl || matrixUrl.includes("files.slack.com")) {
                // We failed to upload the file.
                return null;
            }
            return matrixUrl;
        };

        const mainUrl = await upload(event.url, event.info?.mimetype, event.body);
        if (!mainUrl) {
            return null;
        }
        event.url = mainUrl;

        if (!event.info?.thumbnail_url) {
            return event;
        }

        const thumbnailMimetype = event.info.thumbnail_info?.mimetype ?? event.info.mimetype;
        const thumbnailUrl = await upload(event.info.thumbnail_url, thumbnailMimetype, `thumb-${event.body}`);
        if (thumbnailUrl) {
            event.info.thumbnail_url = thumbnailUrl;
        }

        return event;
    }

    public async onMatrixTyping(currentlyTyping: string[]) {
        log.debug(`${currentlyTyping} are typing in ${this.matrixRoomId}`);
        if (!this.SlackTeamId || !this.SlackChannelId) {
            // We don't handle typing on non-teamed rooms
            return;
        }
        const teamId = this.SlackTeamId;
        const convoId = this.SlackChannelId;
        await Promise.all(currentlyTyping.map(async userId => {
            const res = await this.main.slackRtm?.getUserClient(teamId, userId);
            if (!res) {
                // We don't have a client for this user.
                return;
            }
            return res.sendTyping(convoId);
        }));
    }

    private async getReplyEvent(roomID: string, message: ISlackMessageEvent, slackRoomID: string): Promise<IMatrixReplyEvent | null> {
        // When we're dealing with a "message_changed" event, the actual message is under a `message` property.
        if (message.subtype === "message_changed" && message.message) {
            message = message.message;
        }

        // Get parent event
        const dataStore = this.main.datastore;
        const parentEvent = await dataStore.getEventBySlackId(slackRoomID, message.thread_ts!);
        if (parentEvent === null) {
            log.warn(`Could not find parent matrix event for ${message.thread_ts}`);
            return null;
        }
        let replyToTS = "";
        // Add this event to the list of events in this thread
        if (parentEvent._extras.slackThreadMessages === undefined) {
            parentEvent._extras.slackThreadMessages = [];
        }
        replyToTS = parentEvent._extras.slackThreadMessages.slice(-1)[0] || message.thread_ts!;
        parentEvent._extras.slackThreadMessages.push(message.ts);
        await dataStore.upsertEvent(parentEvent);

        // Get event to reply to
        const replyToEvent = await dataStore.getEventBySlackId(slackRoomID, replyToTS);
        if (replyToEvent === null) {
            log.warn(`Could not find parent matrix event for the latest event in the chain ${replyToTS}`);
            return null;
        }
        const intent = await this.getIntentForRoom(roomID);
        return intent.getEvent(roomID, replyToEvent.eventId);
    }

    /*
        Strip out reply fallbacks. Borrowed from
        https://github.com/turt2live/matrix-js-bot-sdk/blob/master/src/preprocessors/RichRepliesPreprocessor.ts
    */
    private async stripMatrixReplyFallback(event: any): Promise<any> {
        if (!event.content?.body) {
            return event;
        }

        let realHtml = event.content.formatted_body;
        let realText = event.content.body || "";

        if (event.content.format === "org.matrix.custom.html" && realHtml) {
            const formattedBody = realHtml;
            if (formattedBody.startsWith("<mx-reply>") && formattedBody.indexOf("</mx-reply>") !== -1) {
                const parts = formattedBody.split("</mx-reply>");
                realHtml = parts[1];
                event.content.formatted_body = realHtml.trim();
            }
        }

        let processedFallback = false;
        for (const line of realText.split("\n")) {
            if (line.startsWith("> ") && !processedFallback) {
                continue;
            } else if (!processedFallback) {
                realText = line;
                processedFallback = true;
            } else {
                realText += line + "\n";
            }
        }

        event.content.body = realText.trim();
        return event;
    }

    /*
        Given an event which is in reply to something else return the event ID of the
        top most event in the reply chain, i.e. the one without a relates to.
    */
    private async findParentReply(message: any, depth = 0): Promise<string> {
        const MAX_DEPTH = 10;
        // Extract the referenced event
        if (!message.content) { return message.event_id; }
        if (!message.content["m.relates_to"]) { return message.event_id; }
        let parentEventId;
        if (["m.thread", "io.element.thread"].includes(message.content["m.relates_to"].rel_type)) {
            // Parent of a thread
            parentEventId = message.content["m.relates_to"].event_id;
        } else {
            // Next parent of a rely
            if (!message.content["m.relates_to"]["m.in_reply_to"]) { return message.event_id; }
            parentEventId = message.content["m.relates_to"]["m.in_reply_to"].event_id;
        }
        if (!parentEventId || typeof parentEventId !== "string") { return message.event_id; }
        if (depth > MAX_DEPTH) {
            return parentEventId; // We have hit our depth limit, use this one.
        }

        const intent = await this.getIntentForRoom(message.room_id);
        const nextEvent = await intent.getEvent(message.room_id, parentEventId);

        return this.findParentReply(nextEvent, depth++);
    }

    public async getIntentForRoom(roomID?: string) {
        if (this.intent) {
            return this.intent;
        }
        // Ensure we get the right user.
        if (!this.IsPrivate) {
            this.intent = this.main.botIntent; // Non-private channels should have the bot inside.
        }
        const firstGhost = (await this.main.listGhostUsers(roomID ?? this.matrixRoomId))[0];
        this.intent =  this.main.getIntent(firstGhost);
        return this.intent;
    }

    private addRecentSlackMessage(ts: string) {
        log.debug("Recent message key add:", ts);
        this.recentSlackMessages.push(ts);
        if (this.recentSlackMessages.length > RECENT_MESSAGE_MAX) {
            this.recentSlackMessages.shift();
        }
    }
}
