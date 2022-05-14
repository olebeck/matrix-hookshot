export interface GenericWebhookEvent {
    hookData: unknown;
    hookId: string;
}

export interface GenericWebhookEventResult {
    successful?: boolean|null;
    notFound?: boolean;
}


export interface UploadWebhookEvent {
    data: Buffer;
    filename: string
    hookId: string;
}

export interface UploadWebhookEventResult {
    mxc?: string|null;
    notFound?: boolean;
}