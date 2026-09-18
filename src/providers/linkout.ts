/** Placeholder adapter for courses whose booking engine exposes no public availability feed. */
import type { FetchResult, LinkoutConfig, Provider } from "./types.js";

export class LinkoutProvider implements Provider {
  readonly name = "linkout";
  constructor(private readonly cfg: LinkoutConfig) {}

  async fetchDay(): Promise<FetchResult> {
    return {
      status: "manual",
      provider: this.name,
      times: [],
      message: this.cfg.reason ?? "This course has to be checked on its own booking site.",
    };
  }
}
