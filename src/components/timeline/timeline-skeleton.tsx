import { Skeleton } from "@/components/ui/skeleton"

export function TimelineSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="p-4">
          <div className="flex gap-4">
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/3 mt-2" />
            </div>
            {i % 2 === 0 && <Skeleton className="h-20 w-20 rounded-lg shrink-0" />}
          </div>
        </div>
      ))}
    </div>
  )
}
