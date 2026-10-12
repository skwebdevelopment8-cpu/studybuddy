# StudyBuddy

Run locally (Node 18+, no installs needed):

    node server.js      # then open http://localhost:3000

Deploy (Render / Railway / Fly / any Node host):
1. Push this folder to GitHub. Do NOT commit `.env` (it is in .gitignore).
2. Create a Node web service, start command `node server.js`.
3. Add these as environment variables on the host:
   OPENROUTER_API_KEY, NVIDIA_API_KEY, GEMINI_API_KEY, ELEVENLABS_API_KEY
4. Deploy. The host provides HTTPS and sets PORT automatically.

Keys live only on the server; the browser never sees them.
