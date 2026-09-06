-- Leseaufwand senken: die Abfragen des Dashboards liefen ueber volle Tabellendurchlaeufe.
-- Bei 5 Mio. gelesenen Zeilen pro Tag (D1 Free) reicht das aus, um mit einem offenen Tab das
-- Tageslimit zu sprengen. Die Indizes bilden genau die Filter ab, die Dashboard, Publisher und
-- Review verwenden.
CREATE INDEX IF NOT EXISTS idx_clips_ws_status    ON clips(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_clips_ws_campaign  ON clips(workspace_id, campaign_id);
CREATE INDEX IF NOT EXISTS idx_clips_ws_created   ON clips(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_clips_ws_account   ON clips(workspace_id, account, status);
CREATE INDEX IF NOT EXISTS idx_posts_ws_status    ON posts(workspace_id, status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_posts_clip         ON posts(clip_id);
CREATE INDEX IF NOT EXISTS idx_posts_ws_posted    ON posts(workspace_id, posted_at);
CREATE INDEX IF NOT EXISTS idx_events_ws_campaign ON events(workspace_id, campaign_id, id);
CREATE INDEX IF NOT EXISTS idx_videos_ws_status   ON videos(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_videos_ws_channel  ON videos(workspace_id, source, published_at);
CREATE INDEX IF NOT EXISTS idx_uploads_ws_status  ON uploads(workspace_id, status);
