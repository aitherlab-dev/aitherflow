/** An installed plugin (from installed_plugins.json + enriched metadata) */
export interface InstalledPlugin {
  /** Plugin identifier: "plugin-name@marketplace" */
  id: string;
  /** Plugin name */
  name: string;
  /** Marketplace it came from */
  marketplace: string;
  /** Version string (semver or commit hash) */
  version: string;
  /** Scope: "user" or "project" */
  scope: string;
  /** Absolute path to installed files */
  installPath: string;
  /** ISO datetime of installation */
  installedAt: string;
  /** Description from plugin.json (may be empty) */
  description: string;
  /** Number of skills/commands in this plugin */
  skillCount: number;
  /** Whether the plugin is enabled */
  enabled: boolean;
}

/** A plugin available from a marketplace */
export interface AvailablePlugin {
  /** Plugin name */
  name: string;
  /** Description */
  description: string;
  /** Author name */
  author: string;
  /** Version */
  version: string;
  /** Category (development, productivity, etc.) */
  category: string;
  /** Which marketplace it belongs to */
  marketplace: string;
  /** Whether it's already installed */
  isInstalled: boolean;
  /** Number of unique installs (from cache, may be 0) */
  installCount: number;
}

/** Source type for marketplace */
type MarketplaceSourceType = "github" | "git";

/** A marketplace source (from known_marketplaces.json) */
export interface MarketplaceSource {
  /** Marketplace identifier */
  name: string;
  /** Source type */
  sourceType: MarketplaceSourceType;
  /** GitHub "owner/repo" or git URL */
  url: string;
  /** Local path where the repo is cloned */
  installLocation: string;
  /** ISO datetime of last update */
  lastUpdated: string;
}

/** All plugin data for the Settings UI */
export interface PluginsData {
  installed: InstalledPlugin[];
  available: AvailablePlugin[];
  sources: MarketplaceSource[];
}
