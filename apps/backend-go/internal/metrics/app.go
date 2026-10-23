package metrics

import (
	"fmt"
	"io"
	"sync/atomic"
	"time"
)

// AppMetrics counts product-level events (registrations, content).
//
// Like MessengerMetrics these are plain atomics so /metrics stays
// dependency-free. They are used for RATES (events per minute); they are
// process-local and reset on restart, so totals are taken from the database
// instead (see cmd/server). Private messages are deliberately NOT counted:
// what happens in a DM is nobody's metric.
type AppMetrics struct {
	registrations atomic.Uint64
	threads       atomic.Uint64
	posts         atomic.Uint64
	wallPosts     atomic.Uint64

	// Search pipeline: how often the API serves search, and whether the engine
	// or the PostgreSQL fallback answered. A rising fallback counter means the
	// engine is down, misconfigured or erroring — the API keeps working, but
	// the graph is the signal to look at Meilisearch.
	searchRequests       atomic.Uint64
	searchEngineServed   atomic.Uint64
	searchEngineFallback atomic.Uint64

	// Batch profile reads. One request now serves every author on screen; the
	// ids counter shows how much fan-out that one call replaced.
	profileSummaryRequests atomic.Uint64
	profileSummaryIDs      atomic.Uint64

	// Unified feed SQL: how many uncached feed pages hit Postgres, their total
	// time, and how many concurrent stampede requests shared one query via the
	// handler singleflight instead of running it themselves.
	feedSQLQueries      atomic.Uint64
	feedSQLNanos        atomic.Uint64
	feedSingleflightHit atomic.Uint64
}

// App is the process-wide product-metrics instance.
var App = &AppMetrics{}

// RegistrationCreated counts a successful account creation.
func (a *AppMetrics) RegistrationCreated() { a.registrations.Add(1) }

// ThreadCreated counts a successfully created thread.
func (a *AppMetrics) ThreadCreated() { a.threads.Add(1) }

// PostCreated counts a successfully created post inside a thread.
func (a *AppMetrics) PostCreated() { a.posts.Add(1) }

// WallPostCreated counts a successfully created profile-wall post.
func (a *AppMetrics) WallPostCreated() { a.wallPosts.Add(1) }

// SearchRequested counts a /search call carrying a usable query.
func (a *AppMetrics) SearchRequested() { a.searchRequests.Add(1) }

// SearchServedByEngine counts a search answered by Meilisearch.
func (a *AppMetrics) SearchServedByEngine() { a.searchEngineServed.Add(1) }

// SearchEngineFallback counts a search the engine could not answer and the
// PostgreSQL full-text path served instead.
func (a *AppMetrics) SearchEngineFallback() { a.searchEngineFallback.Add(1) }

// ProfileSummaryRequested counts one batched profile read and how many
// profiles it carried (the fan-out the batch replaced).
func (a *AppMetrics) ProfileSummaryRequested(ids int) {
	a.profileSummaryRequests.Add(1)
	if ids > 0 {
		a.profileSummaryIDs.Add(uint64(ids))
	}
}

// FeedSQLObserved records one uncached feed page query and its latency.
func (a *AppMetrics) FeedSQLObserved(d time.Duration) {
	a.feedSQLQueries.Add(1)
	if d > 0 {
		a.feedSQLNanos.Add(uint64(d.Nanoseconds()))
	}
}

// FeedSingleflightHit counts a feed request that shared an in-flight identical
// query instead of running its own (cache-stampede collapse).
func (a *AppMetrics) FeedSingleflightHit() { a.feedSingleflightHit.Add(1) }

// TableCreated maps a generic CRUD insert to a product counter. Only content
// tables are counted; everything else is ignored.
func (a *AppMetrics) TableCreated(table string) {
	if table == "profile_wall_posts" {
		a.WallPostCreated()
	}
}

// writeTo renders the product event counters. Called by the /metrics handler.
func (a *AppMetrics) writeTo(w io.Writer) {
	_, _ = fmt.Fprintf(w,
		"# TYPE app_registrations_total counter\n"+
			"app_registrations_total %d\n"+
			"# TYPE app_threads_created_total counter\n"+
			"app_threads_created_total %d\n"+
			"# TYPE app_posts_created_total counter\n"+
			"app_posts_created_total %d\n"+
			"# TYPE app_wall_posts_created_total counter\n"+
			"app_wall_posts_created_total %d\n"+
			"# TYPE app_search_requests_total counter\n"+
			"app_search_requests_total %d\n"+
			"# TYPE app_search_engine_served_total counter\n"+
			"app_search_engine_served_total %d\n"+
			"# TYPE app_search_engine_fallback_total counter\n"+
			"app_search_engine_fallback_total %d\n"+
			"# TYPE app_profile_summary_requests_total counter\n"+
			"app_profile_summary_requests_total %d\n"+
			"# TYPE app_profile_summary_ids_total counter\n"+
			"app_profile_summary_ids_total %d\n"+
			"# TYPE app_feed_sql_queries_total counter\n"+
			"app_feed_sql_queries_total %d\n"+
			"# TYPE app_feed_sql_seconds_total counter\n"+
			"app_feed_sql_seconds_total %f\n"+
			"# TYPE app_feed_singleflight_hits_total counter\n"+
			"app_feed_singleflight_hits_total %d\n",
		a.registrations.Load(),
		a.threads.Load(),
		a.posts.Load(),
		a.wallPosts.Load(),
		a.searchRequests.Load(),
		a.searchEngineServed.Load(),
		a.searchEngineFallback.Load(),
		a.profileSummaryRequests.Load(),
		a.profileSummaryIDs.Load(),
		a.feedSQLQueries.Load(),
		float64(a.feedSQLNanos.Load())/1e9,
		a.feedSingleflightHit.Load(),
	)
}
