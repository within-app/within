import { memo } from "react"
import ReactMarkdown from "react-markdown"

interface MarkdownContentProps {
  content: string
}

export const MarkdownContent = memo(function MarkdownContent({ content }: MarkdownContentProps) {
  return (
    <div
      className={[
        // Lora reading face at body size + relaxed leading (matches --leading-relaxed: 1.7)
        "font-reading text-[17px] leading-[1.7] text-foreground",
        // Prose plugin + neutral palette + dark-mode invert
        "prose prose-neutral dark:prose-invert max-w-none",
        // Paragraphs — Lora, reading size, relaxed leading, comfortable spacing
        "prose-p:font-reading prose-p:text-[17px] prose-p:leading-[1.7] prose-p:my-[0.85em]",
        // Headings — UI face (sans), semibold, tight tracking
        "prose-headings:font-ui prose-headings:font-semibold prose-headings:tracking-tight",
        "prose-h1:text-[22px] prose-h2:text-[19px] prose-h3:text-[17px]",
        // Blockquotes — italic Lora, primary accent border, muted text
        "prose-blockquote:font-reading prose-blockquote:italic prose-blockquote:border-l-primary prose-blockquote:text-muted-foreground",
        // Inline code — mono, muted pill
        "prose-code:font-mono prose-code:text-[15px] prose-code:bg-muted prose-code:rounded prose-code:px-1 prose-code:py-0.5 prose-code:before:content-none prose-code:after:content-none",
        // Links — primary colour, no underline at rest
        "prose-a:text-primary prose-a:no-underline hover:prose-a:underline",
        // Lists
        "prose-li:leading-[1.7]",
        // HR
        "prose-hr:border-border",
      ].join(" ")}
    >
      <ReactMarkdown>{content}</ReactMarkdown>
    </div>
  )
})
