/** German interface texts by their English source text, split by area of the app. */
import app from "./app";
import dialogs from "./dialogs";
import motion from "./motion";
import sketch from "./sketch";
import workspace from "./workspace";

export const DE_PARTS: Readonly<Record<string, Readonly<Record<string, string>>>> = { app, dialogs, motion, sketch, workspace };

export const DE: Readonly<Record<string, string>> = Object.assign({}, ...Object.values(DE_PARTS));
