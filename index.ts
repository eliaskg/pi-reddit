import registerRedditTools from "./lib/tools.ts";

export default function (pi: import("@earendil-works/pi-coding-agent").ExtensionAPI) {
  registerRedditTools(pi);
}
