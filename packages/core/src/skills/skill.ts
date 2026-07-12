/** A skill/playbook's index entry — everything but its body. */
export interface SkillRef {
  name: string;
  description: string;
  /** Optional scope hint, e.g. "frontend" / "backend" / a repo name. */
  scope?: string;
  /** Absolute path to the skill's markdown file. */
  path: string;
}

/** A skill with its full body (the playbook text after the frontmatter). */
export interface Skill extends SkillRef {
  body: string;
}
