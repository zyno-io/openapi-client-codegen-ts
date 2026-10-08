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

type BytesProvider = () => Promise<Uint8Array>;

// Kept off the instance: React Native's networking copies an upload's own properties
// into the native request, which can't carry functions.
const bytesProviders = new WeakMap<ReactNativeFileUploadRequest, BytesProvider>();

export class ReactNativeFileUploadRequest extends BaseUploadRequest {
    uri: string;

    /**
     * `bytes` reads the file's contents. It is required when FormData is serialized in
     * JavaScript, as `expo/fetch` does; React Native's own networking reads `uri` instead.
     */
    constructor(options: { uri: string; name?: string; type?: string; mimeType?: string; size?: number; bytes?: BytesProvider }) {
        super();
        this.uri = options.uri;
        this.name = options.name ?? (undefined as never);
        this.type = options.type ?? options.mimeType ?? (undefined as never);
        this.size = options.size ?? 0;
        if (options.bytes) bytesProviders.set(this, options.bytes);
    }

    bytes(): Promise<Uint8Array> {
        const provider = bytesProviders.get(this);
        if (!provider) {
            return Promise.reject(
                new Error(
                    `ReactNativeFileUploadRequest for ${this.uri} has no \`bytes\` option, which is required when FormData is serialized in JavaScript (e.g. expo/fetch)`
                )
            );
        }
        return provider();
    }
}

export type FileUploadValue = FileUploadRequest | ReactNativeFileUploadRequest;

function isNativeFileUpload(value: unknown): value is Blob | File {
    return typeof Blob !== 'undefined' && value instanceof Blob;
}

function isFileUpload(value: unknown): value is BaseUploadRequest | Blob | File {
    return value instanceof BaseUploadRequest || isNativeFileUpload(value);
}

/** Whether a body field is sent as file parts: one file, or a non-empty array of them. */
function isFileField(key: string, value: unknown): boolean {
    if (isFileUpload(value)) return true;
    if (!Array.isArray(value) || !value.some(isFileUpload)) return false;
    if (!value.every(isFileUpload)) {
        throw new TypeError(`Field "${key}" mixes file uploads with other values`);
    }
    return true;
}

function appendFilePart(body: FormData, key: string, value: unknown) {
    if (value instanceof ReactNativeFileUploadRequest) {
        body.append(key, value as unknown as Blob);
    } else if (value instanceof FileUploadRequest) {
        body.append(key, value.blob);
    } else if (isNativeFileUpload(value)) {
        body.append(key, value);
    }
}

export function patchRequestOptionsForFileUpload<T extends RequestOptionsLike>(options: T): T {
    if (!options.body || typeof options.body !== 'object') {
        return options;
    }

    const requestBody = options.body as Record<string, unknown>;
    const fileKeys = new Set(
        Object.entries(requestBody)
            .filter(([key, value]) => isFileField(key, value))
            .map(([key]) => key)
    );
    if (!fileKeys.size) return options;

    const body = new FormData();
    const jsonBody: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(requestBody)) {
        if (!fileKeys.has(key)) {
            jsonBody[key] = value;
        } else if (Array.isArray(value)) {
            // Repeated parts under the same name, in order.
            for (const item of value) appendFilePart(body, key, item);
        } else {
            appendFilePart(body, key, value);
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
