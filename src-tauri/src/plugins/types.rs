use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Output types (sent to frontend) ──

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub id: String,
    pub name: String,
    pub marketplace: String,
    pub version: String,
    pub scope: String,
    pub install_path: String,
    pub installed_at: String,
    pub description: String,
    pub skill_count: usize,
    pub enabled: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AvailablePlugin {
    pub name: String,
    pub description: String,
    pub author: String,
    pub version: String,
    pub category: String,
    pub marketplace: String,
    pub is_installed: bool,
    pub install_count: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceSource {
    pub name: String,
    pub source_type: String,
    pub url: String,
    pub install_location: String,
    pub last_updated: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginsData {
    pub installed: Vec<InstalledPlugin>,
    pub available: Vec<AvailablePlugin>,
    pub sources: Vec<MarketplaceSource>,
}

// ── JSON structures on disk (CLI-managed files) ──

#[derive(Deserialize, Debug)]
pub(crate) struct InstalledPluginsFile {
    #[serde(default)]
    pub plugins: HashMap<String, Vec<InstalledEntry>>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstalledEntry {
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub install_path: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub installed_at: String,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(super) struct KnownMarketplacesFile(pub HashMap<String, MarketplaceEntry>);

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(super) struct MarketplaceEntry {
    pub source: MarketplaceSourceDef,
    #[serde(default)]
    pub install_location: String,
    #[serde(default)]
    pub last_updated: String,
}

#[derive(Deserialize, Debug)]
pub(super) struct MarketplaceSourceDef {
    pub source: String,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Deserialize, Debug)]
pub(super) struct MarketplaceManifest {
    #[serde(default)]
    pub plugins: Vec<MarketplacePluginEntry>,
}

#[derive(Deserialize, Debug)]
pub(super) struct MarketplacePluginEntry {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub author: Option<AuthorField>,
    #[serde(default)]
    pub source: Option<PluginSourceField>,
}

#[derive(Deserialize, Debug)]
#[serde(untagged)]
pub(super) enum PluginSourceField {
    /// Local path like "./plugins/feature-dev"
    Path(String),
    /// Remote source like { "source": "url", "url": "https://..." }
    Remote {
        #[allow(dead_code)]
        url: Option<String>,
    },
}

impl PluginSourceField {
    pub fn as_local_path(&self) -> Option<&str> {
        match self {
            PluginSourceField::Path(s) => Some(s),
            PluginSourceField::Remote { .. } => None,
        }
    }

    pub fn as_remote_url(&self) -> Option<&str> {
        match self {
            PluginSourceField::Remote { url } => url.as_deref(),
            PluginSourceField::Path(_) => None,
        }
    }
}

#[derive(Deserialize, Debug)]
#[serde(untagged)]
pub(super) enum AuthorField {
    Struct { name: String },
    Plain(String),
}

impl AuthorField {
    pub fn name(&self) -> &str {
        match self {
            AuthorField::Struct { name } => name,
            AuthorField::Plain(s) => s,
        }
    }
}

#[derive(Deserialize, Debug)]
pub(super) struct PluginJson {
    #[serde(default)]
    pub description: String,
}

#[derive(Deserialize, Debug)]
pub(super) struct InstallCountsFile {
    #[serde(default)]
    pub counts: Vec<InstallCountEntry>,
}

#[derive(Deserialize, Debug)]
pub(super) struct InstallCountEntry {
    #[serde(default)]
    pub plugin: String,
    #[serde(default)]
    pub unique_installs: u64,
}
