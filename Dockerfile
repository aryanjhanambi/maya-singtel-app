FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY --chown=pwuser:pwuser . .
RUN mkdir -p /app/.data && chown -R pwuser:pwuser /app

ENV HOST=0.0.0.0
ENV BROWSER_HEADLESS=true

USER pwuser

CMD ["npm", "start"]
