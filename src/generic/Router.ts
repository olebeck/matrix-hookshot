import { MessageQueue } from "../MessageQueue";
import express, { NextFunction, Request, Response, Router } from "express";
import LogWrapper from "../LogWrapper";
import { ApiError, ErrCode } from "../api";
import { GenericWebhookEvent, GenericWebhookEventResult, UploadWebhookEvent, UploadWebhookEventResult } from "./types";

const WEBHOOK_RESPONSE_TIMEOUT = 5000;

const log = new LogWrapper('GenericWebhooksRouter');
export class GenericWebhooksRouter {
    constructor(private readonly queue: MessageQueue, private readonly deprecatedPath = false) { }

    private onUpload(req: Request<{hookId: string, filename: string, send_message: boolean}, unknown, Buffer, {send?: boolean}>, res: Response<{ok: true, url: string}|{ok: false, error: string}>, next: NextFunction) {
        if(!(req.body instanceof Buffer)) {
            res.status(400).send({ok: false, error: "invalid request"});
        }

        let send_message = req.query.send ? true : false;

        this.queue.pushWait<UploadWebhookEvent, UploadWebhookEventResult>({
            eventName: "upload-webhook.event",
            sender: "GithubWebhooks",
            data: {
                data: req.body,
                filename: req.params.filename,
                hookId: req.params.hookId
            }
        }, WEBHOOK_RESPONSE_TIMEOUT).then((response) => {
            if (response.notFound) {
                if (this.deprecatedPath) {
                    // If the webhook wasn't found and we're on a deprecated path, ignore it.
                    next();
                    return;
                }
                res.status(404).send({ok: false, error: "Webhook not found"});
            } else if (response.mxc) {
                let url = <string>response.mxc;

                if(send_message) {
                    this.queue.pushWait<GenericWebhookEvent, GenericWebhookEventResult>({
                        eventName: 'generic-webhook.event',
                        sender: "GithubWebhooks",
                        data: {
                            hookData: {
                                raw: {
                                    body: req.params.filename,
                                    filename: req.params.filename,
                                    msgtype: "m.file",
                                    url
                                }
                            },
                            hookId: req.params.hookId,
                        },
                    }, WEBHOOK_RESPONSE_TIMEOUT).then((response) => {
                        if (response.successful) {
                            res.status(200).send({ok: true, url});
                        } else if (response.successful === false) {
                            res.status(500).send({ok: false, error: "Failed to process webhook"});
                        } else {
                            res.status(202).send({ok: true, url});
                        }
                    });
                } else {
                    res.status(200).send({ok: true, url});
                }
            } else {
                res.status(500).send({ok: false, error: "Failed to upload file"});
            }
        }).catch((err) => {
            log.error(`Failed to emit payload: ${err}`);
            res.status(500).send({ok: false, error: "Failed to handle upload"});
        });
    }

    private onWebhook(req: Request<{hookId: string}, unknown, unknown, unknown>, res: Response<{ok: true}|{ok: false, error: string}>, next: NextFunction) {
        if (!['PUT', 'GET', 'POST'].includes(req.method)) {
            throw new ApiError("Wrong METHOD. Expecting PUT, GET or POST", ErrCode.MethodNotAllowed);
        }
    
        let body;
        if (req.method === 'GET') {
            body = req.query;
        } else {
            body = req.body;
        }
    
        this.queue.pushWait<GenericWebhookEvent, GenericWebhookEventResult>({
            eventName: 'generic-webhook.event',
            sender: "GithubWebhooks",
            data: {
                hookData: body,
                hookId: req.params.hookId,
            },
        }, WEBHOOK_RESPONSE_TIMEOUT).then((response) => {
            if (response.notFound) {
                if (this.deprecatedPath) {
                    // If the webhook wasn't found and we're on a deprecated path, ignore it.
                    next();
                    return;
                }
                res.status(404).send({ok: false, error: "Webhook not found"});
            } else if (response.successful) {
                res.status(200).send({ok: true});
            } else if (response.successful === false) {
                res.status(500).send({ok: false, error: "Failed to process webhook"});
            } else {
                res.status(202).send({ok: true});
            }
        }).catch((err) => {
            log.error(`Failed to emit payload: ${err}`);
            res.status(500).send({ok: false, error: "Failed to handle webhook"});
        });
    }

    public getRouter() {
        const router = Router();
        router.all(
            '/:hookId',
            express.text({ type: 'text/*'}),
            express.urlencoded({ extended: false }),
            express.json(),
            this.onWebhook.bind(this),
        );
        router.put(
            '/:hookId/upload/:filename',
            express.raw({ limit: "50mb", type: () => {return true;} }),
            this.onUpload.bind(this)
        )
        return router;
    }
}
