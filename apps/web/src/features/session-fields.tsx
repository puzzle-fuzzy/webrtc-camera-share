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
  const roomErrorId = "room-error"
  const keyErrorId = "access-code-error"

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
          aria-errormessage={roomInvalid ? roomErrorId : undefined}
          aria-describedby={roomInvalid ? roomErrorId : undefined}
          autoComplete="off"
          maxLength={32}
          required
          spellCheck={false}
          placeholder="例如 demo-room"
        />
        {roomInvalid && <FieldError id={roomErrorId}>{issue.message}</FieldError>}
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
          aria-errormessage={keyInvalid ? keyErrorId : undefined}
          aria-describedby={keyInvalid ? keyErrorId : undefined}
          autoComplete="off"
          minLength={6}
          maxLength={32}
          required
          placeholder="6 到 32 位字母或数字"
        />
        {keyInvalid && <FieldError id={keyErrorId}>{issue.message}</FieldError>}
      </Field>
    </FieldGroup>
  )
}
