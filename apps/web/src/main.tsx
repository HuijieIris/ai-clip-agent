import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import './styles.css'
import { ToastProvider } from './ui/toast'
import { HomePage } from './pages/HomePage'
import { ImportPage } from './pages/ImportPage'
import { AnalyzePage } from './pages/AnalyzePage'
import { HighlightsPage } from './pages/HighlightsPage'
import { EditorPage } from './pages/EditorPage'
import { ReviewPage } from './pages/ReviewPage'
import { ExportPage } from './pages/ExportPage'
import { DashboardPage, ProjectsPage, AssetsPage, TemplatesPage } from './pages/ListPages'
import { ProjectDetailPage } from './pages/ProjectDetailPage'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/new" element={<ImportPage />} />
          <Route path="/projects/:id" element={<ProjectDetailPage />} />
          <Route path="/projects/:id/analyzing" element={<AnalyzePage />} />
          <Route path="/projects/:id/highlights" element={<HighlightsPage />} />
          <Route path="/projects/:id/editor/:clipId" element={<EditorPage />} />
          <Route path="/projects/:id/review" element={<ReviewPage />} />
          <Route path="/projects/:id/export" element={<ExportPage />} />
          <Route path="/assets" element={<AssetsPage />} />
          <Route path="/templates" element={<TemplatesPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>
)
