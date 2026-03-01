export interface ProjectBookmark {
  path: string;
  name: string;
  additionalDirs?: string[];
}

export interface ProjectsConfig {
  projects: ProjectBookmark[];
  lastOpenedProject: string | null;
}
