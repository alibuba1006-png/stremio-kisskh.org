# Използваме официален Puppeteer образ, който вече има инсталиран Chromium и всички нужни библиотеки
FROM ghcr.io/puppeteer/puppeteer:latest

# Задаваме работната директория
WORKDIR /usr/src/app

# Копираме package.json и package-lock.json
COPY package*.json ./

# Инсталираме зависимостите
RUN npm install

# Копираме останалия код
COPY . .

# Отваряме порт (Render ще го пренасочи автоматично)
EXPOSE 7000

# Стартираме приложението
CMD ["node", "index.js"]
