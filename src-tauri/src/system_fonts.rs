//! Installed font families for the Appearance → Fonts picker.

use std::collections::BTreeMap;

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFontFamily {
    pub family: String,
    /// True when every face of the family is fixed-pitch.
    pub monospace: bool,
}

/// Collapses faces into families. A family counts as monospace only if all of
/// its faces are; names starting with `.` are macOS-private system faces
/// (".SF NS") that CSS cannot address, so they are dropped.
fn collect_families<'a>(faces: impl IntoIterator<Item = (&'a str, bool)>) -> Vec<SystemFontFamily> {
    let mut families: BTreeMap<String, (String, bool)> = BTreeMap::new();
    for (name, monospace) in faces {
        let name = name.trim();
        if name.is_empty() || name.starts_with('.') {
            continue;
        }
        families
            .entry(name.to_lowercase())
            .and_modify(|(_, all_mono)| *all_mono &= monospace)
            .or_insert_with(|| (name.to_string(), monospace));
    }
    families
        .into_values()
        .map(|(family, monospace)| SystemFontFamily { family, monospace })
        .collect()
}

fn list_system_fonts_sync() -> Vec<SystemFontFamily> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    collect_families(db.faces().filter_map(|face| {
        // The first entry is the English (US) name when the font has one,
        // which is what WebKit/WebView2 match `font-family` against.
        face.families
            .first()
            .map(|(name, _)| (name.as_str(), face.monospaced))
    }))
}

#[tauri::command]
pub async fn list_system_fonts() -> Result<Vec<SystemFontFamily>, String> {
    tauri::async_runtime::spawn_blocking(list_system_fonts_sync)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fam(family: &str, monospace: bool) -> SystemFontFamily {
        SystemFontFamily {
            family: family.to_string(),
            monospace,
        }
    }

    #[test]
    fn merges_faces_sorts_and_drops_private_names() {
        let faces = [
            ("Menlo", true),
            ("Helvetica", false),
            (".SF NS", false),
            ("Menlo", true),
            ("  ", false),
            ("Arial", false),
        ];
        assert_eq!(
            collect_families(faces),
            vec![
                fam("Arial", false),
                fam("Helvetica", false),
                fam("Menlo", true)
            ]
        );
    }

    #[test]
    fn family_is_monospace_only_when_every_face_is() {
        let faces = [("Mixed", true), ("mixed", false), ("Mono", true)];
        assert_eq!(
            collect_families(faces),
            vec![fam("Mixed", false), fam("Mono", true)]
        );
    }

    /// Hits the real font directories; run with `--ignored` to eyeball output.
    #[test]
    #[ignore]
    fn loads_installed_families() {
        let families = list_system_fonts_sync();
        let mono = families.iter().filter(|f| f.monospace).count();
        eprintln!("{} families, {mono} monospace", families.len());
        assert!(!families.is_empty());
    }
}
