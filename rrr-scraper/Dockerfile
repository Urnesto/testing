# Official Playwright image — has Chromium + all deps pre-installed and tested
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY sub_sub_categories_keys.txt ./

RUN mkdir -p output

EXPOSE 3000

CMD ["node", "src/server.js"]
