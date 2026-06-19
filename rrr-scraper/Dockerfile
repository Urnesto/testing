# Official Playwright image — has Chromium + all deps pre-installed and tested
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

RUN mkdir -p output proxy

EXPOSE 3000

CMD ["node", "src/server.js"]
