import { z } from "zod"

export const CreateJournalSchema = z.object({
  name:  z.string().trim().min(1, "Name darf nicht leer sein").max(200, "Name darf maximal 200 Zeichen lang sein"),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "color muss ein gültiger Hex-Farbwert sein (z.B. #FF5733)"),
})


export const UpdateJournalSchema = CreateJournalSchema.partial().refine(
  (d) => d.name !== undefined || d.color !== undefined,
  { message: "Mindestens ein Feld (name oder color) angeben" }
)
