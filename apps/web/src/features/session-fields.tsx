import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import type { Session, SessionIssue } from "@/features/session"

type SessionFieldsProps = {
  disabled: boolean
  issue?: SessionIssue
  session: Session
  onChange: (session: Session) => void
}

export function SessionFields({
  disabled,
  issue,
  session,
  onChange,
}: SessionFieldsProps) {
  const roomInvalid = issue?.field === "room"
  const keyInvalid = issue?.field === "key"

  return (
    <FieldGroup className="grid gap-4 md:grid-cols-2">
      <Field data-disabled={disabled || undefined} data-invalid={roomInvalid || undefined}>
        <FieldLabel htmlFor="room">房间 ID</FieldLabel>
        <Input
          id="room"
          value={session.room}
          onChange={(event) => onChange({ ...session, room: event.target.value })}
          disabled={disabled}
          aria-invalid={roomInvalid || undefined}
          autoComplete="off"
          maxLength={32}
          spellCheck={false}
          placeholder="例如 demo-room"
        />
        {roomInvalid && <FieldError>{issue.message}</FieldError>}
      </Field>
      <Field data-disabled={disabled || undefined} data-invalid={keyInvalid || undefined}>
        <FieldLabel htmlFor="access-code">访问码</FieldLabel>
        <Input
          id="access-code"
          type="password"
          value={session.key}
          onChange={(event) => onChange({ ...session, key: event.target.value })}
          disabled={disabled}
          aria-invalid={keyInvalid || undefined}
          autoComplete="off"
          minLength={6}
          maxLength={32}
          placeholder="6 到 32 位字母或数字"
        />
        {keyInvalid && <FieldError>{issue.message}</FieldError>}
      </Field>
    </FieldGroup>
  )
}
