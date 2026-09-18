import { ChronogolfProvider } from "./chronogolf.js";
import { CpsProvider } from "./cps.js";
import { CpsV3Provider } from "./cpsV3.js";
import { LinkoutProvider } from "./linkout.js";
import type { Provider, ProviderConfig, ProviderContext } from "./types.js";

export function createProvider(cfg: ProviderConfig, ctx: ProviderContext): Provider {
  switch (cfg.type) {
    case "chronogolf":
      return new ChronogolfProvider(cfg, ctx);
    case "cps":
      return new CpsProvider(cfg, ctx);
    case "cps_v3":
      return new CpsV3Provider(cfg, ctx);
    case "linkout":
      return new LinkoutProvider(cfg);
    default: {
      const never: never = cfg;
      throw new Error(`Unknown provider config: ${JSON.stringify(never)}`);
    }
  }
}

export * from "./types.js";
