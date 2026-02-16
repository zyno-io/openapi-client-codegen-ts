interface RequestOptionsLike {
    body?: unknown;
    headers?: Record<string, unknown>;
    bodySerializer?: unknown;
}

class BaseUploadRequest {
    validator = null;
    lastModifiedDate = null;
    size = 0;
    path = '';
    name = '';
    type = '';
}

export class FileUploadRequest extends BaseUploadRequest {
    constructor(public blob: Blob) {
        super();
    }
}

export class ReactNativeFileUploadRequest extends BaseUploadRequest {
    uri: string;

    constructor(options: { uri: string; name?: string; type?: string; mimeType?: string; size?: number }) {
        super();
        this.uri = options.uri;
        this.name = options.name ?? (undefined as never);
        this.type = options.type ?? options.mimeType ?? (undefined as never);
        this.size = options.size ?? 0;
    }
}

export function patchRequestOptionsForFileUpload<T extends RequestOptionsLike>(options: T): T {
    if (typeof options.body !== 'object') {
        return options;
    }

    const hasFileUpload = Object.values(options.body as object).some(v => v instanceof BaseUploadRequest);
    if (!hasFileUpload) return options;

    const body = new FormData();
    const jsonBody: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(options.body as object)) {
        if (value instanceof ReactNativeFileUploadRequest) {
            body.append(key, value as unknown as Blob);
        } else if (value instanceof FileUploadRequest) {
            body.append(key, value.blob);
        } else {
            jsonBody[key] = value;
        }
    }
    body.append('_payload', JSON.stringify(jsonBody));

    return {
        ...options,
        headers: {
            ...options.headers,
            'content-type': null // deletes default JSON content-type header
        },
        body,
        bodySerializer: undefined
    };
}
