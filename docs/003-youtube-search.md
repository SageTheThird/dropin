# YouTube Search

Search is implemented through the official YouTube Data API `search.list` endpoint.

## Setup

Create a Google Cloud API key with YouTube Data API v3 enabled.

The easiest local setup is a `.env` file in the project root:

```text
YOUTUBE_API_KEY=your_youtube_data_api_key
```

Then start the app:

```powershell
npm run dev
```

You can also set the environment variable directly:

```powershell
$env:YOUTUBE_API_KEY="your_youtube_data_api_key"
npm run dev
```

## Behavior

- The browser calls `/api/search?q=...`.
- The server calls YouTube and returns normalized video results.
- Clicking a result adds it to the shared queue.
- Search requests `maxResults=50`, which is YouTube's maximum for one `search.list` response.
- Results are whatever YouTube returns for that single request. Playback still happens through the official YouTube iframe in each listener's browser.

## Quota

YouTube's `search.list` costs 100 quota units per call.
The default quota for projects with YouTube Data API enabled is commonly 10,000 units per day, which is roughly 100 searches per day before quota extension.
