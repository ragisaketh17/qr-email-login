const app = require("../server");

module.exports = async (request, response) => {
  try {
    await app.locals.databaseReady;

    const requestUrl = new URL(request.url, "https://vercel.local");
    const routedPath = requestUrl.searchParams.get("__path");
    if (routedPath !== null) {
      requestUrl.searchParams.delete("__path");
      request.url = `/${routedPath.replace(/^\/+/, "")}${requestUrl.search}`;
    }

    return app(request, response);
  } catch (error) {
    console.error(`Database initialization failed: ${error.message}`);
    response.statusCode = 503;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end("Service is temporarily unavailable.");
  }
};
