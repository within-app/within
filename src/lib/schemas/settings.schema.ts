import { z } from "zod"
import { LOCALES } from "@/lib/i18n/config"

export const UpdateSettingsSchema = z.object({
  locale: z.enum(LOCALES, { message: "locale muss de, en oder fr sein" }),
})
