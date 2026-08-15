import express from "express";
import {
  cloudflareAdapter,
  type CloudflareContext,
  type CloudflareRequest,
} from "./cloudflare.adapter";
import { cloudflareBindings, CloudflareBindingsNotConfiguredError } from "./cloudflare-bindings";

interface TestKv {
  getWithMetadata(key: string): Promise<{ value: string | null }>;
}

interface TestEnv {
  SETTINGS: TestKv;
}

const bindings = cloudflareBindings<TestEnv>();
const Settings = bindings.kv("SETTINGS");

const context: CloudflareContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
};

describe("cloudflareAdapter binding services", () => {
  it("installs req.services even when bindings are not configured", async () => {
    const env = { SETTINGS: { getWithMetadata: async () => ({ value: "dark" }) } };
    const app = express();
    app.get("/services", (request, response) => {
      const req = request as CloudflareRequest<TestEnv>;
      response.json({
        sameEnv: req.cloudflare.env === env,
        hasServices: typeof req.services.get === "function",
      });
    });

    const worker = cloudflareAdapter<TestEnv>(app);
    const response = await worker.fetch(
      new Request("https://worker.example/services"),
      env,
      context,
    );

    expect(await response.json()).toEqual({ sameEnv: true, hasServices: true });
  });

  it("surfaces a named configuration error through the application error handler", async () => {
    const app = express();
    app.get("/settings", (request, _response, next) => {
      try {
        const req = request as CloudflareRequest<TestEnv>;
        req.services.get(Settings);
      } catch (error) {
        next(error);
      }
    });
    app.use(((error, _req, res, next) => {
      if (error instanceof CloudflareBindingsNotConfiguredError) {
        res.status(503).json({ code: error.code });
        return;
      }
      next(error);
    }) satisfies express.ErrorRequestHandler);

    const worker = cloudflareAdapter<TestEnv>(app);
    const response = await worker.fetch(
      new Request("https://worker.example/settings"),
      { SETTINGS: { getWithMetadata: async () => ({ value: "dark" }) } },
      context,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "EXPRESSOTS_CLOUDFLARE_BINDINGS_NOT_CONFIGURED",
    });
  });

  it("keeps binding values isolated between concurrent requests", async () => {
    const app = express();
    let entered = 0;
    let release!: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      release = resolve;
    });

    app.get("/settings", async (request, response) => {
      const req = request as CloudflareRequest<TestEnv>;
      entered += 1;
      if (entered === 2) release();
      await bothEntered;
      response.json(await req.services.get(Settings).getWithMetadata("theme"));
    });

    const worker = cloudflareAdapter(app, { bindings });
    const [first, second] = await Promise.all([
      worker.fetch(
        new Request("https://worker.example/settings"),
        { SETTINGS: { getWithMetadata: async () => ({ value: "first" }) } },
        context,
      ),
      worker.fetch(
        new Request("https://worker.example/settings"),
        { SETTINGS: { getWithMetadata: async () => ({ value: "second" }) } },
        context,
      ),
    ]);

    expect(await first.json()).toEqual({ value: "first" });
    expect(await second.json()).toEqual({ value: "second" });
  });
});
