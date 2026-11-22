import { createApp } from "./app";

const { app } = createApp();
const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Express + agent-cms on http://localhost:${port}/api/cms/_me`));
