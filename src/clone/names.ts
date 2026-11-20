// Names and paths the clone's inputs and the workspace file share. Pure, so
// the page can use them too.
import { z } from "zod";

/** One plain folder name: no slash, not only dots, nothing hidden in it. */
export const folderName = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !value.includes("/") && !value.includes("\\"), "must be one folder name, without slashes")
  .refine((value) => !/^\.+$/.test(value), "must not be only dots")
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "must not contain control characters")
  .refine((value) => value.trim() === value, "must not start or end with a space");

/** A path relative to the workspace: no leading slash, no `..`, no empty parts. */
export const relativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !value.startsWith("/"), "must be relative to the workspace")
  .refine((value) => !value.split("/").some((part) => part === ".." || part === ""), "must not contain '..' or empty parts")
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "must not contain control characters");
