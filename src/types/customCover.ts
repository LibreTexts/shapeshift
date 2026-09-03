/**
 * Custom cover configuration served by Commons & Conductor for books whose path
 * begins with `Courses/`. See src/services/customCover.ts for the fetch and
 * normalization rules.
 */

import { SpineImage } from './pdf';

export interface CustomCoverOrg {
  orgID: string;
  name: string;
}

/** The `customCoverConfig` object exactly as Commons returns it. */
export interface CustomCoverConfigResponse {
  enabled: boolean;
  frontTemplateURL: string;
  backTemplateURL: string;
  /** May or may not carry a leading `#`. Normalized before use. */
  spineHexColor: string;
  /**
   * Optional. When present, the artwork is drawn at the top of the spine above
   * the title. Absent or empty means a flat color spine, which is the majority
   * case and costs nothing — nothing is fetched.
   */
  spineImageURL?: string;
  /** Reserved. Path matching happens server-side in Commons for now. */
  matchingPaths?: string[];
}

/** The envelope Commons wraps the config in. */
export interface CustomCoverConfigEnvelope {
  err: boolean;
  msg?: string;
  org?: CustomCoverOrg;
  customCoverConfig?: CustomCoverConfigResponse;
}

/**
 * A configuration whose template PDFs have been downloaded and validated, ready
 * to hand to CoverTemplateService. Only ever produced by
 * `CustomCoverService.resolve()`.
 */
export interface ResolvedCustomCover {
  org: CustomCoverOrg;
  frontTemplateBytes: Uint8Array;
  backTemplateBytes: Uint8Array;
  /** Normalized: always a `#`-prefixed 6-digit hex string. */
  spineHex: string;
  /**
   * The org's spine artwork, normalized for embedding, or null when the config
   * carried no `spineImageURL` — or when the one it carried could not be
   * fetched or decoded. Either way the spine falls back to a flat `spineHex`
   * fill and the custom cover still ships.
   */
  spineImage: SpineImage | null;
}
