/**
 * Structural types for the @hey-api/openapi-ts generated client.
 *
 * Why these exist as manual interfaces rather than imports:
 *
 * Since @hey-api/openapi-ts v0.73.0, the client runtime (Client, RequestOptions,
 * Middleware, etc.) is bundled directly into each generated output as raw .ts
 * source files (copied from dist/clients/fetch/ into the consumer's generated
 * directory). These types are NOT exported from the @hey-api/openapi-ts package
 * and cannot be imported. The standalone @hey-api/client-fetch package still
 * exists but its types diverge from the bundled ones (e.g. different generic
 * signatures on BuildUrlFn, extra SseFn type parameter on CoreClient), making
 * it unusable as a shared type source.
 *
 * The interfaces below are structural contracts that both the bundled generated
 * client and the standalone @hey-api/client-fetch client satisfy. They use
 * method syntax (not property syntax) so TypeScript applies bivariant parameter
 * checking, which is necessary because the generated client's generic function
 * signatures (RequestFn, MethodFn, etc.) would fail strict contravariant checks
 * against our simplified parameter types.
 *
 * If @hey-api/openapi-ts ever exports client runtime types directly, these
 * interfaces should be replaced with imports from that package.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

export interface OpenApiRequestOptions {
    url: string;
    method?: string;
    body?: unknown;
    path?: Record<string, unknown>;
    query?: Record<string, unknown>;
    headers?: object;
    [key: string]: unknown;
}

export interface OpenApiClient {
    setConfig(config: Record<string, unknown>): unknown;
    getConfig(): unknown;
    buildUrl(options: Record<string, unknown>): string;
    interceptors: {
        error: { use(fn: AnyFn): number; eject(id: number | AnyFn): void };
        request: { use(fn: AnyFn): number; eject(id: number | AnyFn): void };
        response: { use(fn: AnyFn): number; eject(id: number | AnyFn): void };
    };
    request(options: OpenApiRequestOptions): Promise<unknown>;
    connect(options: OpenApiRequestOptions): Promise<unknown>;
    delete(options: OpenApiRequestOptions): Promise<unknown>;
    get(options: OpenApiRequestOptions): Promise<unknown>;
    head(options: OpenApiRequestOptions): Promise<unknown>;
    options(options: OpenApiRequestOptions): Promise<unknown>;
    patch(options: OpenApiRequestOptions): Promise<unknown>;
    post(options: OpenApiRequestOptions): Promise<unknown>;
    put(options: OpenApiRequestOptions): Promise<unknown>;
    trace(options: OpenApiRequestOptions): Promise<unknown>;
}

export type OpenApiWrapperFn = (options: OpenApiRequestOptions, fn: (options: OpenApiRequestOptions) => Promise<unknown>) => Promise<unknown>;

export type OpenApiResponse<T> = {
    data: T | undefined;
};

export type OpenApiDataType<T> = T extends OpenApiResponse<infer U> ? NonNullable<U> : never;
