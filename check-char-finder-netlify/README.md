# Check Char Finder (Netlify)

Type a shelf location to get its check character, the locations one headset mistake away,
every location that shares the check character, and AI suggestions on where to search.

## Folder layout

```
site/index.html              the app
netlify/functions/ask.mjs    the AI helper (calls Claude with your API key)
netlify.toml                 Netlify settings
```

## Deploy

This repository includes a root `netlify.toml` that sets this folder as the base
directory, publishes `site`, and deploys `netlify/functions`. When connecting the
whole repository, leave the dashboard build command and base directory empty so
the root configuration applies. No build command is required for this static app.

1. Push this folder to a GitHub repository (or use the Netlify CLI, below).
2. In Netlify: **Add new site > Import an existing project**, pick the repository. Leave the build command empty; the publish directory is read from `netlify.toml`.
3. In **Site configuration > Environment variables**, add:
   - `ANTHROPIC_API_KEY`: your key from https://console.anthropic.com (required for AI)
   - `ACCESS_CODE`: a code colleagues must type to use the AI (recommended)
   - `MODEL`: optional, defaults to `claude-haiku-5-5`
4. Trigger a redeploy (Deploys > Trigger deploy) so the variables take effect.

### Netlify CLI instead of GitHub

```
npm install -g netlify-cli
netlify login
netlify init            # create the site
netlify env:set ANTHROPIC_API_KEY sk-ant-...
netlify env:set ACCESS_CODE yourcode
netlify deploy --prod
```

Drag-and-drop (Netlify Drop) only uploads the page, not the AI function, so use one of the two ways above.

## Cost control

Each question makes 1 to 3 Claude API calls with a short answer. Set a monthly spend limit in the
Anthropic Console (Settings > Limits). The function also limits each visitor to 40 requests per 10 minutes
and only accepts this app's location questions.
