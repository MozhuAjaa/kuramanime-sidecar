# Playwright's own image already carries Chromium plus every shared library it
# needs — the thing a Vercel function cannot install.
#
# Keep this tag in step with the `playwright` version in package.json.
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.mjs ./

ENV SIDECAR_HOST=0.0.0.0
EXPOSE 8080

CMD ["node", "server.mjs"]
