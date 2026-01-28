import "./styles.css";
import { createRoot } from "react-dom/client";
import App from "./app";
import { Providers } from "@/providers";

const root = createRoot(document.getElementById("app")!);

root.render(
  <Providers>
    <div className="bg-ob-base-100 text-base text-ob-base-300 antialiased selection:bg-blue-700 selection:text-white font-serif">
      <App />
    </div>
  </Providers>
);
