import type { OpenApiClient, OpenApiRequestOptions, OpenApiWrapperFn, OpenApiResponse, RequestResult } from './types.js';

import { patchRequestOptionsForFileUpload } from './uploads.js';

export type { OpenApiClient, OpenApiRequestOptions, OpenApiWrapperFn, OpenApiResponse, RequestResult };
export type { OpenApiDataType } from './types.js';

type IHeaders = Record<string, string | null | undefined>;
export interface OpenApiClientOptions {
    wrapper?: OpenApiWrapperFn;
    headers?: IHeaders | ((request: Request) => IHeaders) | ((request: Request) => Promise<IHeaders>);
    onError?: (err: Error, options: OpenApiRequestOptions) => Error | null | void;
}

export function dataFrom<T>(response: OpenApiResponse<T>): T {
    return response.data!;
}

export async function dataFromAsync<T>(promise: Promise<OpenApiResponse<T>>): Promise<T> {
    return (await promise).data!;
}

export class OpenApiError extends Error {
    constructor(
        message: string,
        public readonly request: Request | undefined,
        public readonly response: Response | undefined,
        public readonly body: unknown | undefined,
        public readonly cause?: Error
    ) {
        super(message);
    }
}

export function configureOpenApiClient(client: OpenApiClient, options: OpenApiClientOptions) {
    client.setConfig({
        throwOnError: true
    });

    client.interceptors.error.use((bodyOrErr, response, request, opts) => {
        const message = getMessageFromBodyOrErr(bodyOrErr, response);
        const err = new OpenApiError(
            message,
            request,
            response,
            bodyOrErr instanceof Error ? undefined : bodyOrErr,
            bodyOrErr instanceof Error ? bodyOrErr : undefined
        );

        if (options.onError) {
            const handlerResult = options.onError(err, opts);
            if (handlerResult instanceof Error) {
                throw handlerResult;
            }
            if (handlerResult === null) {
                return new Promise(() => {}); // hang indefinitely
            }
        }

        throw err;
    });

    if (options.headers) {
        client.interceptors.request.use(async request => {
            const headers = typeof options.headers === 'function' ? await options.headers(request) : options.headers;
            if (headers) {
                for (const [key, value] of Object.entries(headers)) {
                    if (value === null) {
                        request.headers.delete(key);
                    } else if (value !== undefined) {
                        request.headers.set(key, value as string);
                    }
                }
            }
            return request;
        });
    }

    const wrapper = options.wrapper ?? ((options, fn) => fn(options));

    const originalRequest = client.request;
    type IRequest = typeof originalRequest;
    type IRequestOptions = Parameters<IRequest>[0];
    const request = ((options: IRequestOptions) => {
        options = patchRequestOptionsForFileUpload(options);
        return wrapper(options, originalRequest);
    }) as IRequest;
    client.request = request;

    client.connect = options => request({ ...options, method: 'CONNECT' });
    client.delete = options => request({ ...options, method: 'DELETE' });
    client.get = options => request({ ...options, method: 'GET' });
    client.head = options => request({ ...options, method: 'HEAD' });
    client.options = options => request({ ...options, method: 'OPTIONS' });
    client.patch = options => request({ ...options, method: 'PATCH' });
    client.post = options => request({ ...options, method: 'POST' });
    client.put = options => request({ ...options, method: 'PUT' });
    client.trace = options => request({ ...options, method: 'TRACE' });
}

function getMessageFromBodyOrErr(bodyOrErr: unknown, response: Response): string {
    if (!response && bodyOrErr instanceof Error) {
        return `${bodyOrErr.name}: ${bodyOrErr.message}`;
    }
    if (bodyOrErr && typeof bodyOrErr === 'object') {
        if ('error' in bodyOrErr && typeof bodyOrErr.error === 'string') {
            return `${bodyOrErr.error} (${response.status})`;
        }
        return JSON.stringify(bodyOrErr);
    }
    return String(bodyOrErr);
}
