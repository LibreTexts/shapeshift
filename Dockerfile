FROM node:20.11-alpine
LABEL org.opencontainers.image.source="https://github.com/LibreTexts/shapeshift"

WORKDIR /usr/src/shapeshift

COPY . .

RUN npm ci
RUN npm run build

ENTRYPOINT ["node", "build/index.js"]