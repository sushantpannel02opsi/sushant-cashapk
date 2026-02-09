# Use Playwright base image (Chromium included)
FROM mcr.microsoft.com/playwright:v1.58.2-jammy

# Set working directory
WORKDIR /app

# Copy package files first (better cache)
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm install --omit=dev

# Copy rest of the app
COPY . .

# Expose port (Railway/Fly/Render use this)
EXPOSE 3000

# Start server
CMD ["npm", "start"]
