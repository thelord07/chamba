/** How a discovered design asset is used. */
export type DesignAssetKind = 'image' | 'spec' | 'prototype' | 'other';

/** One file found in a linked design folder (or named in the frontmatter). */
export interface DesignAsset {
  kind: DesignAssetKind;
  /** Absolute path (with `~` already expanded) to the asset. */
  path: string;
  name: string;
  /** For `spec` assets: a bounded text excerpt so the model can read it inline. */
  excerpt?: string;
}

/**
 * A design source pointer (`.chamba/design/<name>.md`). It LINKS to where the design
 * lives — a Figma URL, an external folder of mockups/specs, and/or a standalone
 * prototype (an `.html` or `.zip` Claude Code / a tool exports). chamba never
 * interprets the design; it resolves and lists it for the editor's model.
 */
export interface DesignRef {
  name: string;
  description: string;
  /** Figma file/frame URL, if the design lives in Figma. */
  figma?: string;
  /** External folder with mockups/specs/prototype (read-only, kept outside the repo). */
  folder?: string;
  /** A standalone prototype to open/run: an `.html` file or a `.zip`. */
  prototype?: string;
  /** Path to the `.chamba/design/<name>.md` pointer file. */
  path: string;
}

/** A design source resolved with its brief and the assets found in its folder. */
export interface Design extends DesignRef {
  /** The brief/prompt — the body after the frontmatter. */
  brief: string;
  /** Assets discovered in `folder` plus the frontmatter `prototype`, categorized. */
  assets: DesignAsset[];
}

/**
 * UI-architecture preference, asked once and reused. Web and mobile are separate
 * because the methodology differs (Atomic Design on the web vs screens+components
 * on Expo/React Native). Stored in `.chamba/design/conventions.json`.
 */
export interface DesignConventions {
  /** Web component architecture, e.g. "atomic", "feature-sliced". */
  web?: string;
  /** Mobile (Expo/React Native) architecture, e.g. "screens", "atomic". */
  mobile?: string;
}
