import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import Layout from './components/Layout';
import Attendance from './pages/Attendance';
import Board from './pages/Board';
import Chores from './pages/Chores';
import Dependencies from './pages/Dependencies';
import Directory from './pages/Directory';
import Hiring from './pages/Hiring';
import Knowledge from './pages/Knowledge';
import Login from './pages/Login';
import People from './pages/People';
import ProjectDetail from './pages/ProjectDetail';
import Projects from './pages/Projects';
import Recurring from './pages/Recurring';
import Reports from './pages/Reports';
import Requests from './pages/Requests';
import Tenders from './pages/Tenders';

function Gate() {
  const { user, loading } = useAuth();
  if (loading) return <div className="boot">Opening the board…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <Layout />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<Gate />}>
        <Route path="/" element={<Board key="mine" scope="mine" />} />
        <Route path="/team" element={<Board key="team" scope="team" />} />
        <Route path="/people" element={<People />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/requests" element={<Requests />} />
        <Route path="/chores" element={<Chores />} />
        <Route path="/attendance" element={<Attendance />} />
        <Route path="/knowledge" element={<Knowledge />} />
        <Route path="/tenders" element={<Tenders />} />
        <Route path="/dependencies" element={<Dependencies />} />
        <Route path="/hiring" element={<Hiring />} />
        <Route path="/projects/:id" element={<ProjectDetail />} />
        <Route path="/repeating" element={<Recurring />} />
        <Route path="/directory" element={<Directory />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/activity" element={<Navigate to="/reports" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
