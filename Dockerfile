FROM python:3.12-alpine
WORKDIR /app
COPY landing/ ./landing/
CMD ["sh", "-c", "cd landing && python3 -m http.server ${PORT:-8080}"]
