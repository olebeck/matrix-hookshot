import { MessageQueue } from "../MessageQueue";
import express, { NextFunction, Request, Response, Router } from "express";
import LogWrapper from "../LogWrapper";
import { GenericWebhookEvent, GenericWebhookEventResult, UploadWebhookEvent, UploadWebhookEventResult } from "../generic/types";
import multer from "multer";
const storage = multer.memoryStorage()
const upload = multer({ storage: storage })

const WEBHOOK_RESPONSE_TIMEOUT = 5000;

//interface DiscordEmbed {}

interface DiscordWebhookParams {
    content?: string;
    username?: string;
    avatar_url?: string;
    //embeds?: DiscordEmbed;
}

interface DiscordWebhookForm {
    payload_json: string;
}

const log = new LogWrapper('GenericWebhooksRouter');
export class DiscordWebhooksRouter {
    constructor(private readonly queue: MessageQueue) { }

    private async uploadFile(filename: string, data: Buffer, hookId: string): Promise<UploadWebhookEventResult> {
        return await this.queue.pushWait<UploadWebhookEvent, UploadWebhookEventResult>({
            eventName: "upload-webhook.event",
            sender: "GithubWebhooks",
            data: {data, filename, hookId}
        }, WEBHOOK_RESPONSE_TIMEOUT);
    }

    private async sendEvent(hookData: unknown, hookId: string): Promise<GenericWebhookEventResult> {
        return await this.queue.pushWait<GenericWebhookEvent, GenericWebhookEventResult>({
            eventName: "generic-webhook.event",
            sender: "GithubWebhooks", 
            data: {hookData, hookId}
        })
    }

    private async onDiscordWebhook(req: Request<{hookId: string}, unknown, DiscordWebhookParams|DiscordWebhookForm, unknown>, res: Response<{ok: true}|{ok: false, error: string}>, next: NextFunction) {

        if(req.files) {
            for (const file of <Express.Multer.File[]>req.files) {
                // upload the file to the homeserver and send to the channel
                const uploadResponse = await this.uploadFile(file.originalname, file.buffer, req.params.hookId);
                if(uploadResponse.notFound) {
                    res.status(404).send({ok: false, error: "Webhook not found"});
                    return;
                }
                if(!uploadResponse.mxc) {
                    res.status(500).send({ok: false, error: "Failed to upload file"});
                    return;
                }

                const sendResponse = await this.sendEvent({
                    raw: {
                        body: file.originalname,
                        filename: file.originalname,
                        msgtype: "m.file",
                        url: uploadResponse.mxc,
                    }
                }, req.params.hookId);
                if(!sendResponse.successful) {
                    res.status(500).send({ok: false, error: "failed to send file"});
                    return;
                }
            }
        }
    
        let payload: DiscordWebhookParams;
        if( (<DiscordWebhookForm>req.body).payload_json ) {
            payload = JSON.parse((<DiscordWebhookForm>req.body).payload_json)
        } else {
            payload = <DiscordWebhookParams>req.body;
        }
        if(payload) {
            if(payload.content) {
                const response = await this.sendEvent({
                    text: payload.content,
                    username: payload.username,
                }, req.params.hookId);
                if(response.notFound) {
                    res.status(404).send({ok: false, error: "Webhook not found"});
                    return;
                }
                if(!response.successful) {
                    res.status(500).send({ok: false, error: "error sending webhook"});
                    return;
                }
                res.status(202).send({ok: true})
            }
        } else {
            res.status(400).send({ok: false, error: "invalid payload"});
            return;
        }
    }

    public getRouter() {
        const router = Router();
        router.post(
            '/:hookId',
            upload.any(),
            express.json(),
            this.onDiscordWebhook.bind(this)
        )
        return router;
    }
}
