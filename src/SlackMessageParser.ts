import {ISlackMessageEvent} from "./BaseSlackHandler";
import {TextualMessageEventContent} from "matrix-bot-sdk";
import * as Slackdown from "Slackdown";

export class SlackMessageParser {
    async parse(event: ISlackMessageEvent): Promise<TextualMessageEventContent> {
        const text = event.text || "";

        // TODO: This is fixing plaintext mentions, but should be refactored.
        // https://github.com/matrix-org/matrix-appservice-slack/issues/110
        const body = text.replace(/<https:\/\/matrix\.to\/#\/@.+:.+\|(.+)>/g, "$1");

        // TODO: Slack's markdown is their own thing that isn't really markdown,
        // but the only parser we have for it is slackdown. However, Matrix expects
        // a variant of markdown that is in the realm of sanity. Currently text
        // will be slack's markdown until we've got a slack -> markdown parser.
        let formattedBody: string = Slackdown.parse(text);

        // Parse blockquotes.
        const blocks: string[] = [];
        let currentQuote = "";
        const quoteDelimiter = "> ";
        for (const line of formattedBody.split("\n")) {
            if (line.startsWith(quoteDelimiter)) {
                currentQuote += line.replace(quoteDelimiter, "") + "<br>";
            } else {
                if (currentQuote !== "") {
                    blocks.push(`<blockquote>${currentQuote}</blockquote>`);
                }
                blocks.push(`${line}<br>`);
                currentQuote = "";
            }
        }
        if (currentQuote !== "") {
            blocks.push(`<blockquote>${currentQuote}</blockquote>`);
        }

        if (blocks.length > 0) {
            formattedBody = blocks.join("");
        }
        formattedBody = formattedBody.replace("\n", "<br>");

        return {
            msgtype: "m.text",
            format: "org.matrix.custom.html",
            body,
            formatted_body: formattedBody,
        };
    }
}
