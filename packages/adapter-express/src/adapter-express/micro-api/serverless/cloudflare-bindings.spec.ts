import {
  CloudflareBindingNotFoundError,
  CloudflareBindingsNotConfiguredError,
  type CloudflareServices,
  cloudflareBindings,
  createCloudflareServices,
  createUnconfiguredCloudflareServices,
} from "./cloudflare-bindings";

interface FakeKv {
  getWithMetadata(key: string): Promise<{ value: string | null }>;
}

interface FakeD1 {
  prepare(query: string): object;
  batch(statements: Array<object>): Promise<Array<object>>;
  exec(query: string): Promise<object>;
}

interface FakeR2 {
  head(key: string): Promise<object | null>;
  createMultipartUpload(key: string): Promise<object>;
}

interface FakeQueue {
  send(value: unknown): Promise<void>;
  sendBatch(values: Array<unknown>): Promise<void>;
}

interface AmbiguousBinding extends FakeKv, FakeQueue {}

interface TestEnv {
  SETTINGS: FakeKv;
  DB: FakeD1;
  FILES: FakeR2;
  JOBS: FakeQueue;
  AMBIGUOUS: AmbiguousBinding;
  TEXT: string;
}

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

const typedBindings = cloudflareBindings<TestEnv>();
const Settings = typedBindings.kv("SETTINGS");
const Database = typedBindings.d1("DB");
const Files = typedBindings.r2("FILES");
const Jobs = typedBindings.queue("JOBS");

function inferSettings(services: CloudflareServices) {
  return services.get(Settings);
}

type SettingsType = Assert<Equal<ReturnType<typeof inferSettings>, FakeKv>>;
void (null as unknown as SettingsType);
void Database;
void Files;
void Jobs;

// Explicit Env types narrow names using Cloudflare's structural interfaces.
// @ts-expect-error D1 is not structurally a KV namespace
typedBindings.kv("DB");
// @ts-expect-error plain values are not bindings
typedBindings.queue("TEXT");
// @ts-expect-error values matching multiple kinds are intentionally ambiguous
typedBindings.kv("AMBIGUOUS");

// Without an explicit Env type, callers retain a string-keyed escape hatch.
const defaultBindings = cloudflareBindings();
void defaultBindings.kv("RUNTIME_CONFIGURED_NAME");

describe("cloudflareBindings", () => {
  const kv: FakeKv = {
    getWithMetadata: async () => ({ value: "dark" }),
  };

  it("resolves the binding directly from the current environment", () => {
    const services = createCloudflareServices({ SETTINGS: kv });

    expect(services.get(Settings)).toBe(kv);
    expect(services.get(Settings)).toBe(kv);
  });

  it("memoizes frozen tokens by kind and binding name", () => {
    const anotherBindings = cloudflareBindings<TestEnv>();
    const anotherSettings = anotherBindings.kv("SETTINGS");
    const queueWithSameName = cloudflareBindings<Record<string, unknown>>().queue("SETTINGS");

    expect(Object.isFrozen(Settings)).toBe(true);
    expect(anotherSettings).toBe(Settings);
    expect(queueWithSameName).not.toBe(Settings);
  });

  it("throws a named error for a missing binding", () => {
    const services = createCloudflareServices({});

    expect(() => services.get(Settings)).toThrow(CloudflareBindingNotFoundError);
    expect(() => services.get(Settings)).toThrow(
      expect.objectContaining({
        code: "EXPRESSOTS_CLOUDFLARE_BINDING_NOT_FOUND",
        message: expect.stringContaining("SETTINGS"),
      }),
    );
  });

  it.each(["toString", "constructor"])(
    "does not resolve the inherited %s property as a binding",
    (bindingName) => {
      const token = cloudflareBindings().kv(bindingName);
      const services = createCloudflareServices({});

      expect(() => services.get(token)).toThrow(CloudflareBindingNotFoundError);
    },
  );

  it("throws a named error when binding providers were not configured", () => {
    const services = createUnconfiguredCloudflareServices();

    expect(() => services.get(Settings)).toThrow(CloudflareBindingsNotConfiguredError);
    expect(() => services.get(Settings)).toThrow(
      expect.objectContaining({
        code: "EXPRESSOTS_CLOUDFLARE_BINDINGS_NOT_CONFIGURED",
      }),
    );
  });
});
