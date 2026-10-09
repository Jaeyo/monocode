//! Batched GitHub Inbox reads. One GraphQL query covers many repositories, so
//! an Inbox over dozens of projects costs a few requests instead of two per
//! repository, which is what tripped GitHub's secondary rate limit.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::fs::{
    gh_graphql, github_avatar_url, split_github_repo, GitHubAssignee, GitHubLabel, GitHubWorkItem,
};

/// Repositories per list query. Small enough that a slow or failing alias does
/// not hold up the whole Inbox, large enough to stay at a few requests.
const LIST_REPOS_PER_QUERY: usize = 10;
/// The change probe reads one timestamp per repository, so it batches wider.
const PROBE_REPOS_PER_QUERY: usize = 30;
/// Assigned items come from one account-wide search; cap its pagination.
const SEARCH_MAX_PAGES: usize = 3;

#[derive(Serialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitHubRateLimit {
    pub limit: i64,
    pub remaining: i64,
    pub reset_at: String,
    /// Points the batch spent, summed over its queries.
    pub cost: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubInboxRepo {
    pub repo: String,
    pub items: Vec<GitHubWorkItem>,
    /// Newest `updatedAt` over the repository's issues and pull requests in
    /// any state, so closing an item also counts as a change.
    pub latest_updated_at: String,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubInboxBatch {
    pub repos: Vec<GitHubInboxRepo>,
    pub viewer: String,
    pub rate_limit: Option<GitHubRateLimit>,
}

/// Issues and pull requests for many repositories in a few GraphQL requests.
#[tauri::command]
pub async fn git_github_inbox_items(
    repos: Vec<String>,
    assigned_to_me: bool,
    state: String,
    limit: Option<u32>,
) -> Result<GitHubInboxBatch, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let all = state.trim().eq_ignore_ascii_case("all");
        let limit = limit.unwrap_or(40).clamp(1, 100);
        if assigned_to_me {
            inbox_assigned(&repos, all, gh_graphql)
        } else {
            inbox_lists(&repos, all, limit, gh_graphql)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The newest activity per repository, for deciding which ones to refetch.
#[tauri::command]
pub async fn git_github_inbox_probe(repos: Vec<String>) -> Result<GitHubInboxBatch, String> {
    tauri::async_runtime::spawn_blocking(move || inbox_probe(&repos, gh_graphql))
        .await
        .map_err(|e| e.to_string())?
}

type Runner = fn(&[&str]) -> Result<String, String>;

struct Target {
    repo: String,
    owner: String,
    name: String,
}

fn targets(repos: &[String]) -> (Vec<Target>, Vec<GitHubInboxRepo>) {
    let mut seen = std::collections::HashSet::new();
    let mut valid = Vec::new();
    let mut invalid = Vec::new();
    for repo in repos {
        match split_github_repo(repo) {
            Ok((owner, name)) => {
                let repo = format!("{owner}/{name}");
                if seen.insert(repo.to_lowercase()) {
                    valid.push(Target { repo, owner, name });
                }
            }
            Err(error) => invalid.push(failed_repo(repo.trim(), error)),
        }
    }
    (valid, invalid)
}

fn failed_repo(repo: &str, error: String) -> GitHubInboxRepo {
    GitHubInboxRepo {
        repo: repo.to_string(),
        items: Vec::new(),
        latest_updated_at: String::new(),
        error: Some(error),
    }
}

const ISSUE_FIELDS: &str = "number title url state createdAt updatedAt \
labels(first: 20) { nodes { name color } } assignees(first: 10) { nodes { login } }";
const PR_FIELDS: &str = "number title url state isDraft createdAt updatedAt \
labels(first: 20) { nodes { name color } } assignees(first: 10) { nodes { login } }";
const LATEST: &str = "first: 1, orderBy: { field: UPDATED_AT, direction: DESC }";
const TRAILER: &str = "rateLimit { limit remaining resetAt cost } viewer { login }";

fn issue_fields(state_reason: bool) -> String {
    if state_reason {
        format!("{ISSUE_FIELDS} stateReason")
    } else {
        ISSUE_FIELDS.to_string()
    }
}

/// One aliased `repository` block per target, bound through variables so
/// owner and name never need GraphQL string escaping.
fn repository_query(chunk: &[Target], body: &str) -> (String, Vec<String>) {
    let mut params = Vec::new();
    let mut blocks = String::new();
    let mut fields = Vec::new();
    for (index, target) in chunk.iter().enumerate() {
        params.push(format!("$o{index}: String!, $n{index}: String!"));
        blocks.push_str(&format!(
            "r{index}: repository(owner: $o{index}, name: $n{index}) {{ {body} }} "
        ));
        fields.push(format!("o{index}={}", target.owner));
        fields.push(format!("n{index}={}", target.name));
    }
    let query = format!("query({}) {{ {blocks}{TRAILER} }}", params.join(", "));
    (query, fields)
}

fn list_body(all: bool, limit: u32, state_reason: bool) -> String {
    let states = if all { "" } else { "states: [OPEN], " };
    let page = format!("{states}first: {limit}, orderBy: {{ field: UPDATED_AT, direction: DESC }}");
    format!(
        "issues({page}) {{ nodes {{ {} }} }} \
         pullRequests({page}) {{ nodes {{ {PR_FIELDS} }} }} \
         latestIssue: issues({LATEST}) {{ nodes {{ updatedAt }} }} \
         latestPr: pullRequests({LATEST}) {{ nodes {{ updatedAt }} }}",
        issue_fields(state_reason)
    )
}

fn probe_body() -> String {
    format!(
        "latestIssue: issues({LATEST}) {{ nodes {{ updatedAt }} }} \
         latestPr: pullRequests({LATEST}) {{ nodes {{ updatedAt }} }}"
    )
}

fn run_query(run: Runner, query: &str, fields: &[String]) -> Result<String, String> {
    let query = format!("query={query}");
    let mut args = vec!["api", "graphql", "-f", query.as_str()];
    for field in fields {
        args.push("-f");
        args.push(field);
    }
    run(&args)
}

/// Older GitHub Enterprise Server releases predate `Issue.stateReason`.
fn missing_state_reason(error: &str) -> bool {
    error.contains("stateReason") && error.contains("doesn't exist")
}

fn inbox_lists(
    repos: &[String],
    all: bool,
    limit: u32,
    run: Runner,
) -> Result<GitHubInboxBatch, String> {
    let (valid, invalid) = targets(repos);
    let chunks: Vec<&[Target]> = valid.chunks(LIST_REPOS_PER_QUERY).collect();
    // The process-wide gh permits cap how many of these actually run at once.
    let results: Vec<Result<Parsed, String>> = std::thread::scope(|scope| {
        let handles: Vec<_> = chunks
            .iter()
            .map(|chunk| scope.spawn(move || list_chunk(chunk, all, limit, run)))
            .collect();
        handles
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .unwrap_or_else(|_| Err("GitHub Inbox query panicked".into()))
            })
            .collect()
    });
    merge(chunks, results, invalid)
}

fn list_chunk(chunk: &[Target], all: bool, limit: u32, run: Runner) -> Result<Parsed, String> {
    let (query, fields) = repository_query(chunk, &list_body(all, limit, true));
    let json = match run_query(run, &query, &fields) {
        Err(error) if missing_state_reason(&error) => {
            let (query, fields) = repository_query(chunk, &list_body(all, limit, false));
            run_query(run, &query, &fields)?
        }
        result => result?,
    };
    let parsed = parse_response(&json, chunk)?;
    if parsed
        .errors
        .iter()
        .any(|error| missing_state_reason(error))
    {
        let (query, fields) = repository_query(chunk, &list_body(all, limit, false));
        return parse_response(&run_query(run, &query, &fields)?, chunk);
    }
    Ok(parsed)
}

fn inbox_probe(repos: &[String], run: Runner) -> Result<GitHubInboxBatch, String> {
    let (valid, invalid) = targets(repos);
    let chunks: Vec<&[Target]> = valid.chunks(PROBE_REPOS_PER_QUERY).collect();
    let results = chunks
        .iter()
        .map(|chunk| {
            let (query, fields) = repository_query(chunk, &probe_body());
            parse_response(&run_query(run, &query, &fields)?, chunk)
        })
        .collect();
    merge(chunks, results, invalid)
}

/// A failed chunk marks each of its repositories failed; the batch fails only
/// when nothing at all came back, so callers can keep their last snapshot.
fn merge(
    chunks: Vec<&[Target]>,
    results: Vec<Result<Parsed, String>>,
    mut repos: Vec<GitHubInboxRepo>,
) -> Result<GitHubInboxBatch, String> {
    let mut viewer = String::new();
    let mut rate_limit: Option<GitHubRateLimit> = None;
    let mut first_error = None;
    let mut succeeded = chunks.is_empty();
    for (chunk, result) in chunks.into_iter().zip(results) {
        match result {
            Ok(parsed) => {
                succeeded = true;
                if viewer.is_empty() {
                    viewer = parsed.viewer;
                }
                rate_limit = combine_rate_limits(rate_limit, parsed.rate_limit);
                repos.extend(parsed.repos);
            }
            Err(error) => {
                first_error.get_or_insert_with(|| error.clone());
                repos.extend(
                    chunk
                        .iter()
                        .map(|target| failed_repo(&target.repo, error.clone())),
                );
            }
        }
    }
    if !succeeded {
        return Err(first_error.unwrap_or_else(|| "GitHub returned nothing".into()));
    }
    Ok(GitHubInboxBatch {
        repos,
        viewer,
        rate_limit,
    })
}

/// Latest quota snapshot wins; costs add up across the batch's queries.
fn combine_rate_limits(
    current: Option<GitHubRateLimit>,
    next: Option<GitHubRateLimit>,
) -> Option<GitHubRateLimit> {
    match (current, next) {
        (Some(current), Some(next)) => {
            let cost = current.cost + next.cost;
            let latest = if next.remaining <= current.remaining {
                next
            } else {
                current
            };
            Some(GitHubRateLimit { cost, ..latest })
        }
        (current, next) => next.or(current),
    }
}

#[derive(Deserialize)]
struct Nodes<T> {
    #[serde(default = "Vec::new")]
    nodes: Vec<Option<T>>,
}

// Derived `Default` would needlessly require `T: Default`.
impl<T> Default for Nodes<T> {
    fn default() -> Self {
        Self { nodes: Vec::new() }
    }
}

#[derive(Deserialize)]
struct Label {
    name: String,
    #[serde(default)]
    color: String,
}

#[derive(Deserialize)]
struct Login {
    login: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Node {
    #[serde(default, rename = "__typename")]
    typename: String,
    number: i64,
    title: String,
    url: String,
    state: String,
    #[serde(default)]
    state_reason: Option<String>,
    #[serde(default)]
    is_draft: bool,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    labels: Option<Nodes<Label>>,
    #[serde(default)]
    assignees: Option<Nodes<Login>>,
    #[serde(default)]
    repository: Option<NameWithOwner>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NameWithOwner {
    name_with_owner: String,
}

#[derive(Deserialize)]
struct Stamp {
    #[serde(rename = "updatedAt")]
    updated_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryData {
    #[serde(default)]
    issues: Option<Nodes<Node>>,
    #[serde(default)]
    pull_requests: Option<Nodes<Node>>,
    #[serde(default)]
    latest_issue: Option<Nodes<Stamp>>,
    #[serde(default)]
    latest_pr: Option<Nodes<Stamp>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RateLimitData {
    limit: i64,
    remaining: i64,
    reset_at: String,
    #[serde(default)]
    cost: i64,
}

#[derive(Deserialize)]
struct ErrorData {
    #[serde(default)]
    message: String,
    #[serde(default)]
    path: Vec<serde_json::Value>,
}

struct Parsed {
    repos: Vec<GitHubInboxRepo>,
    viewer: String,
    rate_limit: Option<GitHubRateLimit>,
    errors: Vec<String>,
}

fn work_item(node: Node, kind: &str, repo: &str) -> GitHubWorkItem {
    GitHubWorkItem {
        kind: kind.to_string(),
        number: node.number,
        title: node.title,
        url: node.url,
        state: node.state.to_lowercase(),
        state_reason: node.state_reason.unwrap_or_default().to_lowercase(),
        created_at: node.created_at,
        updated_at: node.updated_at,
        labels: node
            .labels
            .unwrap_or_default()
            .nodes
            .into_iter()
            .flatten()
            .map(|label| GitHubLabel {
                name: label.name,
                color: label.color,
            })
            .collect(),
        assignees: node
            .assignees
            .unwrap_or_default()
            .nodes
            .into_iter()
            .flatten()
            .map(|assignee| GitHubAssignee {
                avatar_url: github_avatar_url(&assignee.login),
                login: assignee.login,
            })
            .collect(),
        draft: node.is_draft,
        repo: repo.to_string(),
    }
}

fn latest(stamps: [Option<Nodes<Stamp>>; 2]) -> String {
    stamps
        .into_iter()
        .flatten()
        .flat_map(|stamps| stamps.nodes.into_iter().flatten())
        .map(|stamp| stamp.updated_at)
        // RFC 3339 UTC timestamps from GitHub order lexicographically.
        .max()
        .unwrap_or_default()
}

fn envelope(json: &str) -> Result<(serde_json::Value, Vec<ErrorData>), String> {
    let mut value: serde_json::Value =
        serde_json::from_str(json).map_err(|error| error.to_string())?;
    let errors: Vec<ErrorData> = serde_json::from_value(value["errors"].take()).unwrap_or_default();
    let data = value["data"].take();
    if !data.is_object() {
        let message = errors
            .first()
            .map(|error| error.message.clone())
            .unwrap_or_else(|| "GitHub returned no data".into());
        return Err(message);
    }
    Ok((data, errors))
}

fn trailer(data: &mut serde_json::Value) -> (String, Option<GitHubRateLimit>) {
    let viewer = data["viewer"]["login"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let rate_limit = serde_json::from_value::<RateLimitData>(data["rateLimit"].take())
        .ok()
        .map(|rate| GitHubRateLimit {
            limit: rate.limit,
            remaining: rate.remaining,
            reset_at: rate.reset_at,
            cost: rate.cost,
        });
    (viewer, rate_limit)
}

fn parse_response(json: &str, chunk: &[Target]) -> Result<Parsed, String> {
    let (mut data, errors) = envelope(json)?;
    let mut by_alias: HashMap<String, String> = HashMap::new();
    let mut unscoped = Vec::new();
    for error in &errors {
        match error.path.first().and_then(|alias| alias.as_str()) {
            Some(alias) => {
                by_alias
                    .entry(alias.to_string())
                    .or_insert_with(|| error.message.clone());
            }
            None => unscoped.push(error.message.clone()),
        }
    }
    let (viewer, rate_limit) = trailer(&mut data);
    let repos = chunk
        .iter()
        .enumerate()
        .map(|(index, target)| {
            let alias = format!("r{index}");
            let block = serde_json::from_value::<Option<RepositoryData>>(data[&alias].take())
                .map_err(|error| error.to_string());
            match block {
                Ok(Some(block)) => {
                    let mut items: Vec<GitHubWorkItem> = Vec::new();
                    for (kind, nodes) in [("issue", block.issues), ("pr", block.pull_requests)] {
                        items.extend(
                            nodes
                                .unwrap_or_default()
                                .nodes
                                .into_iter()
                                .flatten()
                                .map(|node| work_item(node, kind, &target.repo)),
                        );
                    }
                    GitHubInboxRepo {
                        repo: target.repo.clone(),
                        items,
                        latest_updated_at: latest([block.latest_issue, block.latest_pr]),
                        error: by_alias.get(&alias).cloned(),
                    }
                }
                Ok(None) => failed_repo(
                    &target.repo,
                    by_alias
                        .get(&alias)
                        .or(unscoped.first())
                        .cloned()
                        .unwrap_or_else(|| "GitHub did not return this repository".into()),
                ),
                Err(error) => failed_repo(&target.repo, error),
            }
        })
        .collect();
    Ok(Parsed {
        repos,
        viewer,
        rate_limit,
        errors: errors.into_iter().map(|error| error.message).collect(),
    })
}

const SEARCH_QUERY: &str = "query($q: String!, $after: String) { \
search(query: $q, type: ISSUE, first: 100, after: $after) { \
pageInfo { hasNextPage endCursor } \
nodes { __typename \
... on Issue { NODE_ISSUE repository { nameWithOwner } } \
... on PullRequest { NODE_PR repository { nameWithOwner } } } } \
TRAILER }";

fn search_query(state_reason: bool) -> String {
    SEARCH_QUERY
        .replace("NODE_ISSUE", &issue_fields(state_reason))
        .replace("NODE_PR", PR_FIELDS)
        .replace("TRAILER", TRAILER)
}

/// Assigned items through one account-wide search: pull requests cannot be
/// filtered by assignee per repository, and search caps its query length well
/// below what dozens of `repo:` qualifiers need.
fn inbox_assigned(repos: &[String], all: bool, run: Runner) -> Result<GitHubInboxBatch, String> {
    let (valid, mut invalid) = targets(repos);
    let mut by_repo: HashMap<String, Vec<GitHubWorkItem>> = valid
        .iter()
        .map(|target| (target.repo.to_lowercase(), Vec::new()))
        .collect();
    let q = format!(
        "assignee:@me sort:updated-desc{}",
        if all { "" } else { " is:open" }
    );
    let q_field = format!("q={q}");
    let mut state_reason = true;
    let mut cursor: Option<String> = None;
    let mut viewer = String::new();
    let mut rate_limit = None;
    let mut page = 0;
    while page < SEARCH_MAX_PAGES {
        let query = format!("query={}", search_query(state_reason));
        let after = cursor.as_ref().map(|cursor| format!("after={cursor}"));
        let mut args = vec![
            "api",
            "graphql",
            "-f",
            query.as_str(),
            "-f",
            q_field.as_str(),
        ];
        if let Some(after) = after.as_deref() {
            args.extend(["-f", after]);
        }
        let json = match run(&args) {
            Err(error) if state_reason && missing_state_reason(&error) => {
                state_reason = false;
                continue;
            }
            result => result?,
        };
        let (mut data, errors) = envelope(&json)?;
        if state_reason
            && errors
                .iter()
                .any(|error| missing_state_reason(&error.message))
        {
            state_reason = false;
            continue;
        }
        page += 1;
        let (login, rate) = trailer(&mut data);
        if viewer.is_empty() {
            viewer = login;
        }
        rate_limit = combine_rate_limits(rate_limit, rate);
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct PageInfo {
            has_next_page: bool,
            #[serde(default)]
            end_cursor: Option<String>,
        }
        let nodes: Nodes<Node> =
            serde_json::from_value(data["search"].clone()).map_err(|error| error.to_string())?;
        let info: Option<PageInfo> = serde_json::from_value(data["search"]["pageInfo"].take()).ok();
        for node in nodes.nodes.into_iter().flatten() {
            let kind = match node.typename.as_str() {
                "Issue" => "issue",
                "PullRequest" => "pr",
                _ => continue,
            };
            let Some(repo) = node
                .repository
                .as_ref()
                .map(|repository| repository.name_with_owner.clone())
            else {
                continue;
            };
            if let Some(items) = by_repo.get_mut(&repo.to_lowercase()) {
                let canonical = valid
                    .iter()
                    .find(|target| target.repo.eq_ignore_ascii_case(&repo))
                    .map_or(repo.clone(), |target| target.repo.clone());
                items.push(work_item(node, kind, &canonical));
            }
        }
        match info {
            Some(PageInfo {
                has_next_page: true,
                end_cursor: Some(next),
            }) => cursor = Some(next),
            _ => break,
        }
    }
    invalid.extend(valid.iter().map(|target| {
        GitHubInboxRepo {
            repo: target.repo.clone(),
            items: by_repo
                .remove(&target.repo.to_lowercase())
                .unwrap_or_default(),
            // A search cannot say what changed per repository; probes skip this mode.
            latest_updated_at: String::new(),
            error: None,
        }
    }));
    Ok(GitHubInboxBatch {
        repos: invalid,
        viewer,
        rate_limit,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static CALLS: Mutex<Vec<Vec<String>>> = Mutex::new(Vec::new());
    static RESPONSES: Mutex<Vec<Result<String, String>>> = Mutex::new(Vec::new());
    // Tests share the scripted runner, so they must not interleave.
    static SERIAL: Mutex<()> = Mutex::new(());

    fn scripted(args: &[&str]) -> Result<String, String> {
        CALLS
            .lock()
            .unwrap()
            .push(args.iter().map(|arg| arg.to_string()).collect());
        RESPONSES.lock().unwrap().remove(0)
    }

    fn script(responses: Vec<Result<String, String>>) -> std::sync::MutexGuard<'static, ()> {
        let guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        CALLS.lock().unwrap().clear();
        *RESPONSES.lock().unwrap() = responses;
        guard
    }

    fn calls() -> Vec<Vec<String>> {
        CALLS.lock().unwrap().clone()
    }

    const TRAILER_JSON: &str = r#""rateLimit":{"limit":5000,"remaining":4990,"resetAt":"2026-10-09T13:00:00Z","cost":3},"viewer":{"login":"maya"}"#;

    #[test]
    fn lists_many_repositories_in_one_query_and_keeps_partial_results() {
        let _guard = script(vec![Ok(format!(
            r#"{{"data":{{"r0":{{
                "issues":{{"nodes":[{{"number":5,"title":"Bug","url":"u","state":"OPEN","stateReason":null,
                    "createdAt":"c","updatedAt":"2026-10-09T10:00:00Z",
                    "labels":{{"nodes":[{{"name":"bug","color":"d73a4a"}}]}},
                    "assignees":{{"nodes":[{{"login":"maya"}}]}}}}]}},
                "pullRequests":{{"nodes":[{{"number":7,"title":"Fix","url":"p","state":"OPEN","isDraft":true,
                    "updatedAt":"2026-10-09T09:00:00Z"}}]}},
                "latestIssue":{{"nodes":[{{"updatedAt":"2026-10-09T11:00:00Z"}}]}},
                "latestPr":{{"nodes":[{{"updatedAt":"2026-10-09T09:00:00Z"}}]}}
            }},"r1":null,{TRAILER_JSON}}},
            "errors":[{{"path":["r1"],"message":"Could not resolve to a Repository"}}]}}"#
        ))]);
        let batch = inbox_lists(
            &["acme/web".into(), "acme/gone".into(), "ACME/web".into()],
            false,
            40,
            scripted,
        )
        .unwrap();

        let calls = calls();
        assert_eq!(
            calls.len(),
            1,
            "duplicates and repositories share one query"
        );
        let query = &calls[0][3];
        assert!(query.contains("r0: repository(owner: $o0, name: $n0)"));
        assert!(query.contains("states: [OPEN], first: 40"));
        assert!(query.contains("stateReason"));
        assert!(calls[0].contains(&"o1=acme".to_string()));
        assert!(calls[0].contains(&"n1=gone".to_string()));

        assert_eq!(batch.viewer, "maya");
        assert_eq!(batch.rate_limit.as_ref().unwrap().remaining, 4990);
        let web = &batch.repos[0];
        assert_eq!(web.repo, "acme/web");
        assert_eq!(web.error, None);
        assert_eq!(web.latest_updated_at, "2026-10-09T11:00:00Z");
        assert_eq!(web.items.len(), 2);
        assert_eq!(web.items[0].kind, "issue");
        assert_eq!(web.items[0].state, "open");
        assert_eq!(web.items[0].labels[0].name, "bug");
        assert_eq!(web.items[0].assignees[0].login, "maya");
        assert_eq!(web.items[1].kind, "pr");
        assert!(web.items[1].draft);
        let gone = &batch.repos[1];
        assert_eq!(gone.repo, "acme/gone");
        assert_eq!(
            gone.error.as_deref(),
            Some("Could not resolve to a Repository")
        );
    }

    #[test]
    fn all_states_drop_the_open_filter() {
        let _guard = script(vec![Ok(format!(
            r#"{{"data":{{"r0":null,{TRAILER_JSON}}}}}"#
        ))]);
        inbox_lists(&["acme/web".into()], true, 100, scripted).unwrap();
        let query = &calls()[0][3];
        assert!(!query.contains("states: [OPEN]"));
        assert!(query.contains("first: 100"));
    }

    #[test]
    fn retries_without_state_reason_on_older_enterprise_servers() {
        let _guard = script(vec![
            Err("GraphQL: Field 'stateReason' doesn't exist on type 'Issue'".into()),
            Ok(format!(r#"{{"data":{{"r0":null,{TRAILER_JSON}}}}}"#)),
        ]);
        inbox_lists(&["acme/web".into()], false, 40, scripted).unwrap();
        let calls = calls();
        assert_eq!(calls.len(), 2);
        assert!(!calls[1][3].contains("stateReason"));
    }

    #[test]
    fn a_failed_query_fails_the_batch_so_callers_keep_their_snapshot() {
        let _guard = script(vec![Err("GraphQL: API rate limit exceeded".into())]);
        assert_eq!(
            inbox_lists(&["acme/web".into()], false, 40, scripted).unwrap_err(),
            "GraphQL: API rate limit exceeded"
        );
    }

    #[test]
    fn probe_reads_only_the_newest_timestamps() {
        let _guard = script(vec![Ok(format!(
            r#"{{"data":{{"r0":{{"latestIssue":{{"nodes":[]}},
                "latestPr":{{"nodes":[{{"updatedAt":"2026-10-09T12:00:00Z"}}]}}}},{TRAILER_JSON}}}}}"#
        ))]);
        let batch = inbox_probe(&["acme/web".into()], scripted).unwrap();
        let query = &calls()[0][3];
        assert!(!query.contains("labels"));
        assert_eq!(batch.repos[0].latest_updated_at, "2026-10-09T12:00:00Z");
        assert!(batch.repos[0].items.is_empty());
    }

    #[test]
    fn assigned_items_come_from_one_search_mapped_to_requested_repositories() {
        let node = |kind: &str, repo: &str, number: i64| {
            format!(
                r#"{{"__typename":"{kind}","number":{number},"title":"t","url":"u","state":"OPEN",
                    "updatedAt":"2026-10-09T10:00:00Z","repository":{{"nameWithOwner":"{repo}"}}}}"#
            )
        };
        let _guard = script(vec![
            Ok(format!(
                r#"{{"data":{{"search":{{"pageInfo":{{"hasNextPage":true,"endCursor":"c1"}},
                    "nodes":[{},{}]}},{TRAILER_JSON}}}}}"#,
                node("Issue", "Acme/Web", 1),
                node("PullRequest", "other/repo", 2)
            )),
            Ok(format!(
                r#"{{"data":{{"search":{{"pageInfo":{{"hasNextPage":false,"endCursor":null}},
                    "nodes":[{}]}},{TRAILER_JSON}}}}}"#,
                node("PullRequest", "acme/web", 3)
            )),
        ]);
        let batch = inbox_assigned(&["acme/web".into()], false, scripted).unwrap();
        let calls = calls();
        assert_eq!(calls.len(), 2);
        assert!(calls[0].contains(&"q=assignee:@me sort:updated-desc is:open".to_string()));
        assert!(calls[1].contains(&"after=c1".to_string()));
        assert_eq!(batch.repos.len(), 1);
        let items = &batch.repos[0].items;
        assert_eq!(
            items
                .iter()
                .map(|item| (item.kind.as_str(), item.number))
                .collect::<Vec<_>>(),
            [("issue", 1), ("pr", 3)]
        );
        assert!(items.iter().all(|item| item.repo == "acme/web"));
        assert_eq!(batch.rate_limit.unwrap().cost, 6);
    }

    #[test]
    fn invalid_repositories_are_reported_without_a_request() {
        let _guard = script(vec![]);
        let batch = inbox_lists(&["not-a-repo".into()], false, 40, scripted).unwrap();
        assert!(calls().is_empty());
        assert!(batch.repos[0].error.is_some());
    }
}
