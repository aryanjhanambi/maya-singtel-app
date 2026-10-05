FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ENV HOST=0.0.0.0
ENV BROWSER_HEADLESS=true

CMD ["npm", "start"]
