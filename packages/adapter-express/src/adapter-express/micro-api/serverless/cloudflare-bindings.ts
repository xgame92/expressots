import {
  CLOUDFLARE_BINDING_TOKEN_BRAND,
  CLOUDFLARE_SERVICES_FACTORY,
  type CloudflareServicesFactory,
} from "./cloudflare-bindings.contract.js";

export type CloudflareBindingKind = "kv" | "d1" | "r2" | "queue";

type IsMethod<T> = T extends (...args: infer Args) => unknown
  ? Args extends Array<unknown>
    ? true
    : false
  : false;

type AllMethods<T, Keys extends PropertyKey> = false extends {
  [Key in Keys]: Key extends keyof T ? IsMethod<T[Key]> : false;
}[Keys]
  ? false
  : true;

type MatchesKind<T, Kind extends CloudflareBindingKind> = Kind extends "kv"
  ? AllMethods<T, "getWithMetadata">
  : Kind extends "d1"
    ? AllMethods<T, "prepare" | "batch" | "exec">
    : Kind extends "r2"
      ? AllMethods<T, "head" | "createMultipartUpload">
      : AllMethods<T, "send" | "sendBatch">;

type MatchingKinds<T> = {
  [Kind in CloudflareBindingKind]: MatchesKind<T, Kind> extends true ? Kind : never;
}[CloudflareBindingKind];

type ExactBindingKey<TEnv, Kind extends CloudflareBindingKind> = Extract<
  {
    [Key in keyof TEnv]-?: [MatchingKinds<TEnv[Key]>] extends [Kind]
      ? [Kind] extends [MatchingKinds<TEnv[Key]>]
        ? Key
        : never
      : never;
  }[keyof TEnv],
  string
>;

type BindingKey<TEnv, Kind extends CloudflareBindingKind> = string extends keyof TEnv
  ? string
  : ExactBindingKey<TEnv, Kind>;

type BindingValue<TEnv, Key extends string> = Key extends keyof TEnv ? TEnv[Key] : unknown;

export interface CloudflareBindingToken<T> {
  readonly [CLOUDFLARE_BINDING_TOKEN_BRAND]: true;
  readonly bindingName: string;
  readonly kind: CloudflareBindingKind;
  readonly __valueType?: T;
}

export interface CloudflareServices {
  get<T>(token: CloudflareBindingToken<T>): T;
}

export interface CloudflareBindings<TEnv extends object> {
  kv<Key extends BindingKey<TEnv, "kv">>(
    bindingName: Key,
  ): CloudflareBindingToken<BindingValue<TEnv, Key>>;
  d1<Key extends BindingKey<TEnv, "d1">>(
    bindingName: Key,
  ): CloudflareBindingToken<BindingValue<TEnv, Key>>;
  r2<Key extends BindingKey<TEnv, "r2">>(
    bindingName: Key,
  ): CloudflareBindingToken<BindingValue<TEnv, Key>>;
  queue<Key extends BindingKey<TEnv, "queue">>(
    bindingName: Key,
  ): CloudflareBindingToken<BindingValue<TEnv, Key>>;
  readonly [CLOUDFLARE_SERVICES_FACTORY]: CloudflareServicesFactory<TEnv>;
}

export class CloudflareBindingNotFoundError extends Error {
  public readonly code = "EXPRESSOTS_CLOUDFLARE_BINDING_NOT_FOUND";

  public constructor(bindingName: string) {
    super(`Cloudflare binding "${bindingName}" is not available in this request`);
    this.name = "CloudflareBindingNotFoundError";
  }
}

export class CloudflareBindingsNotConfiguredError extends Error {
  public readonly code = "EXPRESSOTS_CLOUDFLARE_BINDINGS_NOT_CONFIGURED";

  public constructor(bindingName: string) {
    super(
      `Cloudflare binding providers are not configured; pass bindings to cloudflareAdapter before resolving "${bindingName}"`,
    );
    this.name = "CloudflareBindingsNotConfiguredError";
  }
}

const tokenCaches: Record<CloudflareBindingKind, Map<string, CloudflareBindingToken<unknown>>> = {
  kv: new Map(),
  d1: new Map(),
  r2: new Map(),
  queue: new Map(),
};

function createBindingToken<T>(
  bindingName: string,
  kind: CloudflareBindingKind,
): CloudflareBindingToken<T> {
  const cache = tokenCaches[kind];
  const cached = cache.get(bindingName);
  if (cached) {
    return cached as CloudflareBindingToken<T>;
  }

  const token = Object.freeze({
    [CLOUDFLARE_BINDING_TOKEN_BRAND]: true as const,
    bindingName,
    kind,
  });
  cache.set(bindingName, token);
  return token as CloudflareBindingToken<T>;
}

function assertBindingToken<T>(token: CloudflareBindingToken<T>): void {
  if (
    token === null ||
    typeof token !== "object" ||
    token[CLOUDFLARE_BINDING_TOKEN_BRAND] !== true ||
    typeof token.bindingName !== "string" ||
    !Object.prototype.hasOwnProperty.call(tokenCaches, token.kind)
  ) {
    throw new TypeError("Cloudflare services require a Cloudflare binding token");
  }
}

export function createCloudflareServices<TEnv extends object>(env: TEnv): CloudflareServices {
  const runtimeEnv = env as Record<string, unknown>;

  return {
    get<T>(token: CloudflareBindingToken<T>): T {
      assertBindingToken(token);
      const value = runtimeEnv[token.bindingName];
      if (value === undefined) {
        throw new CloudflareBindingNotFoundError(token.bindingName);
      }
      return value as T;
    },
  };
}

export function createUnconfiguredCloudflareServices(): CloudflareServices {
  return {
    get<T>(token: CloudflareBindingToken<T>): T {
      assertBindingToken(token);
      throw new CloudflareBindingsNotConfiguredError(token.bindingName);
    },
  };
}

export function cloudflareBindings<
  TEnv extends object = Record<string, unknown>,
>(): CloudflareBindings<TEnv> {
  return {
    kv: (bindingName) => createBindingToken(bindingName, "kv"),
    d1: (bindingName) => createBindingToken(bindingName, "d1"),
    r2: (bindingName) => createBindingToken(bindingName, "r2"),
    queue: (bindingName) => createBindingToken(bindingName, "queue"),
    [CLOUDFLARE_SERVICES_FACTORY]: (env) => createCloudflareServices(env),
  } as CloudflareBindings<TEnv>;
}
