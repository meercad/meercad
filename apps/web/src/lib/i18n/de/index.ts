/** German interface texts by their English source text, split by area of the app. */
import app from "./app";
import bend from "./bend";
import closures from "./closures";
import dialogs from "./dialogs";
import materials from "./materials";
import motion from "./motion";
import sketch from "./sketch";
import storage from "./storage";
import texture from "./texture";
import workspace from "./workspace";

export const DE_PARTS: Readonly<Record<string, Readonly<Record<string, string>>>> = { app, bend, closures, dialogs, materials, motion, sketch, storage, texture, workspace };

export const DE: Readonly<Record<string, string>> = Object.assign({}, ...Object.values(DE_PARTS));
