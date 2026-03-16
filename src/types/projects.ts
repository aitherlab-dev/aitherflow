export interface ProjectBookmark {
  path: string;
  name: string;
  additionalDirs?: string[];
  teamworkEnabled?: boolean;
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
