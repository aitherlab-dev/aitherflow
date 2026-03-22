export interface ProjectBookmark {
  path: string;
  name: string;
  additionalDirs?: string[];
}

export interface WelcomeCard {
  projectPath: string;
  projectName: string;
}

export interface ProjectsConfig {
  projects: ProjectBookmark[];
  lastOpenedProject: string | null;
  lastOpenedChatId: string | null;
  welcomeCards: WelcomeCard[];
}
