import { buildApp } from "./app.js";
import { loadEnvironment } from "./config.js";

const environment = loadEnvironment(process.env);
const app = await buildApp();

await app.listen({ host: environment.HOST, port: environment.PORT });
