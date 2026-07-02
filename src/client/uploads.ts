interface RequestOptionsLike {
    body?: unknown;
    headers?: object;
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

function isNativeFileUpload(value: unknown): value is Blob | File {
    return typeof Blob !== 'undefined' && value instanceof Blob;
}

function isFileUpload(value: unknown): value is BaseUploadRequest | Blob | File {
    return value instanceof BaseUploadRequest || isNativeFileUpload(value);
}

export function patchRequestOptionsForFileUpload<T extends RequestOptionsLike>(options: T): T {
    if (!options.body || typeof options.body !== 'object') {
        return options;
    }

    const requestBody = options.body as Record<string, unknown>;
    const hasFileUpload = Object.values(requestBody).some(isFileUpload);
    if (!hasFileUpload) return options;

    const body = new FormData();
    const jsonBody: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(requestBody)) {
        if (value instanceof ReactNativeFileUploadRequest) {
            body.append(key, value as unknown as Blob);
        } else if (value instanceof FileUploadRequest) {
            body.append(key, value.blob);
        } else if (isNativeFileUpload(value)) {
            body.append(key, value);
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
